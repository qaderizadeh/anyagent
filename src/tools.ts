/**
 * The built-in tool: shell. That is the whole tool surface, on purpose.
 *
 * Everything the agent needs — inspecting the system, creating and editing
 * files, installing and running programs, verifying results — goes through
 * shell commands, so the agent stays tiny and works on any OS.
 *
 * Each tool has a JSON `definition` (for the model) and an `execute`
 * function. The agent never special-cases individual tools.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";

import type { ToolDefinition } from "./model.js";

export type ToolContext = {
  cwd: string;
};

export type Tool = {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
};

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
const MAX_STREAM_CHARS = 100_000;
/**
 * How long to wait after killing a command before resolving its result
 * anyway. Orphaned grandchildren (a server started with `npm start`, a
 * Windows process spawned from WSL) can survive the kill and keep the
 * stdout/stderr pipes open, so 'close' may never fire.
 */
const KILL_GRACE_MS = 750;

type ShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** true when the command hit the timeout and was killed */
  timedOut?: true;
  /** true when the user stopped the command with Ctrl+C */
  interrupted?: true;
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new ToolError(`Argument "${key}" must be a string.`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ */
/* process-tree helpers (shared by the timeout and the Ctrl+C path)     */
/* ------------------------------------------------------------------ */

/** Direct children of a pid: /proc on Linux, `pgrep -P` elsewhere. */
function readChildren(pid: number): number[] {
  try {
    const raw = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
    const ids: number[] = [];
    for (const token of raw.trim().split(/\s+/)) {
      const p = Number.parseInt(token, 10);
      if (Number.isInteger(p)) ids.push(p);
    }
    return ids;
  } catch {
    // Not Linux, or the process is already gone — try pgrep.
  }
  try {
    const res = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
    if (res.status === 0 && res.stdout) {
      return res.stdout
        .trim()
        .split(/\s+/)
        .map((token) => Number.parseInt(token, 10))
        .filter((p) => Number.isInteger(p));
    }
  } catch {
    // pgrep not available
  }
  return [];
}

/** Collect every descendant of a pid (npm -> node -> server -> esbuild...). */
function collectDescendants(rootPid: number): number[] {
  const all: number[] = [];
  const seen = new Set<number>();
  const walk = (pid: number) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    for (const childPid of readChildren(pid)) {
      all.push(childPid);
      walk(childPid);
    }
  };
  walk(rootPid);
  return all;
}

/**
 * Kill a child and everything it spawned. On Windows `taskkill /T /F`
 * kills the whole tree in one call; on POSIX npm/tsx put children in
 * their own process group, so we walk the descendant tree and kill it
 * leaf-first, then the process group, then the child itself.
 */
function killProcessTree(child: ChildProcess): void {
  if (child.pid == null) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // best effort
    }
    return;
  }
  for (const pid of collectDescendants(child.pid).reverse()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already exited
    }
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // already exited
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already exited
  }
}

/* ------------------------------------------------------------------ */
/* the command that is running right now, so Ctrl+C can stop it         */
/* ------------------------------------------------------------------ */

/** State of the command that is running right now (null when idle). */
type ActiveCommand = {
  child: ChildProcess;
  interrupted: boolean;
  forceResolve: () => void;
};

let activeCommand: ActiveCommand | null = null;

/**
 * Kill the shell command the agent is currently running, if any. The CLI
 * calls this when the user presses Ctrl+C: the command dies, its tool
 * result reaches the model marked `interrupted`, and the session stays
 * alive instead of the user having to kill the whole process.
 *
 * Returns false when no command is running (so the caller can exit).
 */
export function abortActiveCommand(): boolean {
  const active = activeCommand;
  if (active == null) return false;
  active.interrupted = true;
  killProcessTree(active.child);
  active.forceResolve();
  return true;
}

/* ------------------------------------------------------------------ */
/* shell                                                               */
/* ------------------------------------------------------------------ */

async function executeShell(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const command = requireString(args, "command").trim();
  if (command === "") {
    throw new ToolError('Argument "command" must be a non-empty string.');
  }

  const timeoutMs = envInt("DEEPSEEK_SHELL_TIMEOUT_MS", DEFAULT_SHELL_TIMEOUT_MS);

  return new Promise((resolvePromise) => {
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;
    // Set once the command is registered below; shared with the module-level
    // slot so abortActiveCommand() flips the flag this call reads back.
    let state: ActiveCommand | null = null;

    let child: ChildProcess;
    try {
      // `shell: true` lets Node pick the platform shell: sh/bash on POSIX,
      // cmd.exe on Windows — one tool that works on every OS. `detached`
      // makes the child a process-group leader on POSIX so a kill can
      // reach the whole group.
      child = spawn(command, {
        cwd: ctx.cwd,
        shell: true,
        detached: process.platform !== "win32",
        windowsHide: true,
        // The agent is never interactive: commands that read stdin get
        // EOF immediately instead of hanging until the timeout (ssh
        // passphrase prompts, pagers, `read`, npm login, ...).
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolvePromise({ exitCode: -1, stdout: "", stderr: `Failed to start command: ${errorMessage(error)}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutCut = false;
    let stderrCut = false;
    let timedOut = false;

    const cutNote = (cut: boolean) =>
      cut ? `\n[... output truncated at ${MAX_STREAM_CHARS} characters]` : "";
    const outcomeNote = () => {
      if (state?.interrupted) return "\n[command interrupted by the user (Ctrl+C) and was killed]";
      if (timedOut) return `\n[command timed out after ${timeoutMs} ms and was killed]`;
      return "";
    };

    const buildResult = (exitCode: number): ShellResult => {
      const result: ShellResult = {
        exitCode,
        stdout: stdout + cutNote(stdoutCut),
        stderr: stderr + cutNote(stderrCut) + outcomeNote(),
      };
      if (timedOut) result.timedOut = true;
      if (state?.interrupted) result.interrupted = true;
      return result;
    };

    const resolveOnce = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (forceTimer) {
        clearTimeout(forceTimer);
        forceTimer = undefined;
      }
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (activeCommand?.child === child) activeCommand = null;
      resolvePromise(buildResult(exitCode));
    };

    /** Resolve shortly after a kill, even if orphaned pipes stay open. */
    const resolveSoonAfterKill = () => {
      if (settled || forceTimer) return;
      forceTimer = setTimeout(() => resolveOnce(-1), KILL_GRACE_MS);
    };

    const appendLimited = (current: string, chunk: Buffer) => {
      const room = MAX_STREAM_CHARS - current.length;
      if (room <= 0) return { value: current, truncated: true };
      const text = chunk.toString();
      return { value: current + text.slice(0, room), truncated: text.length > room };
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const r = appendLimited(stdout, chunk);
      stdout = r.value;
      stdoutCut = stdoutCut || r.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const r = appendLimited(stderr, chunk);
      stderr = r.value;
      stderrCut = stderrCut || r.truncated;
    });
    child.on("error", (error) => {
      if (forceTimer) {
        clearTimeout(forceTimer);
        forceTimer = undefined;
      }
      stderr += `\n${errorMessage(error)}`;
      resolveOnce(-1);
    });
    child.on("close", (code) => {
      resolveOnce(code == null ? -1 : code);
    });

    // Register this command as the one Ctrl+C can stop. `state` is shared
    // with the module-level slot, and a late resolve from a previous
    // command can never read the flag of the next one.
    state = { child, interrupted: false, forceResolve: resolveSoonAfterKill };
    activeCommand = state;

    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      resolveSoonAfterKill();
    }, timeoutMs);
  });
}

const shellTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "shell",
      description:
        "Execute a shell command in the agent's working directory and return stdout, stderr, and exit code. " +
        "Use this for everything: inspecting the system, creating and editing files, installing and running programs, verifying results. " +
        "Commands are non-interactive: stdin is empty (reads return EOF), so prompting tools will not work. " +
        "Long-running processes (servers, watchers, tunnels) are killed after the timeout; " +
        "to keep one running, launch it in the background with nohup ... > log 2>&1 & " +
        "and then verify it with a separate command.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute.",
          },
        },
        required: ["command"],
      },
    },
  },
  execute: executeShell,
};

export const tools: Record<string, Tool> = {
  shell: shellTool,
};
