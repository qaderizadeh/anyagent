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

import { spawn, spawnSync } from "node:child_process";
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
    const resolveOnce = (exitCode: number, stdout: string, stderr: string) => {
      if (!settled) {
        settled = true;
        resolvePromise({ exitCode, stdout, stderr });
      }
    };

    let child;
    try {
      // `shell: true` lets Node pick the platform shell: sh/bash on POSIX,
      // cmd.exe on Windows — one tool that works on every OS. `detached`
      // makes the child a process-group leader on POSIX so a timeout can
      // kill the whole tree instead of just the shell wrapper.
      child = spawn(command, {
        cwd: ctx.cwd,
        shell: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolveOnce(-1, "", `Failed to start command: ${errorMessage(error)}`);
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutCut = false;
    let stderrCut = false;
    let timedOut = false;

    const cutNote = (cut: boolean) =>
      cut ? `\n[... output truncated at ${MAX_STREAM_CHARS} characters]` : "";
    const timeoutNote = () =>
      timedOut ? `\n[command timed out after ${timeoutMs} ms and was killed]` : "";

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
      resolveOnce(-1, stdout + cutNote(stdoutCut), stderr + cutNote(stderrCut) + `\n${errorMessage(error)}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveOnce(code == null ? -1 : code, stdout + cutNote(stdoutCut), stderr + cutNote(stderrCut) + timeoutNote());
    });

    /** Direct children of a pid: /proc on Linux, `pgrep -P` elsewhere. */
    const readChildren = (pid: number): number[] => {
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
    };

    /** Collect every descendant of a pid (npm -> node -> server -> esbuild...). */
    const collectDescendants = (rootPid: number): number[] => {
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
    };

    /**
     * Kill the child and everything it spawned. On Windows `taskkill /T /F`
     * kills the whole tree in one call; on POSIX npm/tsx put children in
     * their own process group, so we walk the descendant tree and kill it
     * leaf-first, then the process group.
     */
    const killTree = () => {
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
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // Orphaned grandchildren (e.g. a long-running server started with
      // `npm start`) may survive the kill and keep the pipes open, so the
      // 'close' event may never fire. Force a resolution shortly after the
      // kill so the agent loop can never wedge on this tool call.
      setTimeout(
        () =>
          resolveOnce(
            -1,
            stdout + cutNote(stdoutCut),
            stderr + cutNote(stderrCut) + timeoutNote(),
          ),
        750,
      );
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
        "Long-running processes (servers, watchers) are killed after the timeout; " +
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