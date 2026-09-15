/**
 * The agent: a loop, one command, one answer shape.
 *
 *   task -> model -> {"text": "...", "command": "..."} -> run one command -> ...
 *
 * No conversation state lives here. The chat is the one open in the browser
 * window, and everything in it stays on chat.deepseek.com.
 */

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { Browser, Completion } from "./browser.js";

const MAX_STEPS = intEnv("DEEPSEEK_MAX_ITERATIONS", 50);
const SHELL_TIMEOUT_MS = intEnv("DEEPSEEK_SHELL_TIMEOUT_MS", 120_000);
const MAX_OUTPUT_CHARS = 30_000;
/** Extra attempts allowed for a reply we cannot use. */
const MAX_RETRIES = 2;
/** Wait before asking again when nothing came back (it may be a hiccup). */
const RETRY_DELAY_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const IS_WINDOWS = process.platform === "win32";
const OS_NAME = IS_WINDOWS ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";

/**
 * The shell commands run in: bash where it exists, the Windows command
 * interpreter otherwise. Set ANYAGENT_SHELL to a path or a name to override.
 */
export function resolveShell(): string {
  const configured = (process.env["ANYAGENT_SHELL"] ?? "").trim();
  if (configured !== "") return configured;
  if (IS_WINDOWS) return onPath("bash.exe") ?? process.env["COMSPEC"] ?? "cmd.exe";
  return "/bin/bash";
}

function onPath(file: string): string | undefined {
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (dir !== "" && existsSync(path.join(dir, file))) return path.join(dir, file);
  }
  return undefined;
}

/** The shell's short name, so the model writes commands that actually run. */
export function shellName(): string {
  const file = resolveShell().split(/[\\/]/).pop() ?? "";
  return file.replace(/\.exe$/i, "");
}

/** The one answer shape. Sent with every task, so it wins over older history. */
export function header(): string {
  const shell = shellName();
  return [
    `You are a command-line agent on the user's ${OS_NAME} computer. Commands run in ${shell}, one at a time.`,
    "Always reply with one JSON object in exactly this shape and nothing else -",
    "no prose, no markdown, no code fence:",
    `{"text": "short note for the user", "command": "the ${shell} command to run"}`,
    'Put "" in "command" when the task is done, or when you are blocked and need',
    'the user to do something - explain that in "text".',
    "Never claim something worked unless a command result showed it.",
  ].join("\n");
}

const NUDGE =
  'Reply with one JSON object only, nothing else: {"text": "...", "command": "..."} - an empty command means you are done.';

export type ShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/* ------------------------------------------------------------------ */
/* tool                                                                */
/* ------------------------------------------------------------------ */

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
}

/** Run one shell command and always resolve with its exit code and output. */
export function runShell(command: string, cwd: string): Promise<ShellResult> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        shell: resolveShell(),
        timeout: SHELL_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: number | string; killed?: boolean }) | null;
        const exitCode =
          failure == null ? 0 : typeof failure.code === "number" ? failure.code : 1;
        // A shell that never started reports itself only in the error, so keep
        // that too - otherwise the failure is just "exit 1" with no reason.
        const missing = failure != null && typeof failure.code === "string" ? failure.message : "";
        const killed = failure?.killed ? `[killed after ${SHELL_TIMEOUT_MS}ms]` : "";
        resolve({
          exitCode,
          stdout: clip(String(stdout)),
          stderr: clip(
            [String(stderr).trim(), missing, killed].filter((part) => part !== "").join("\n"),
          ),
        });
      },
    );
  });
}

/* ------------------------------------------------------------------ */
/* reply parsing                                                       */
/* ------------------------------------------------------------------ */

export type Reply = {
  /** What to tell the user. */
  text: string;
  /** Empty means: done, blocked, or waiting for the user. */
  command: string;
};

function asObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Read {"text","command"} out of a reply. Returns null if there is none. */
export function parseReply(reply: string): Reply | null {
  // Models like to wrap the object in a fence or in a sentence around it.
  const body = reply.replace(/```[a-z]*\s*/gi, "").trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  const wrapped = start >= 0 && end > start ? body.slice(start, end + 1) : body;
  const object = asObject(body) ?? asObject(wrapped);
  if (object == null) return null;

  const field = (value: unknown): string =>
    typeof value === "string" ? value.trim() : "";

  return { text: field(object["text"]), command: field(object["command"]) };
}

/* ------------------------------------------------------------------ */
/* agent                                                               */
/* ------------------------------------------------------------------ */

export type AgentEvents = {
  /** What the model says about the step it is taking. */
  onText?: (text: string) => void;
  onTool?: (command: string) => void;
  onToolResult?: (result: ShellResult) => void;
};

export class Agent {
  constructor(
    private readonly browser: Browser,
    private readonly cwd: string,
  ) {}

  get id(): string {
    return this.browser.currentChatId();
  }

  /** Continue an existing chat session. */
  async openSession(chatId: string): Promise<void> {
    await this.browser.openSession(chatId);
  }

  /** Start a new chat session. */
  async newSession(): Promise<void> {
    await this.browser.newSession();
  }

  async run(task: string, events: AgentEvents = {}): Promise<string> {
    let prompt = `${header()}\n\nTask: ${task}`;
    let quiet = 0; // nothing came back from the model
    let garbled = 0; // it answered, but not in the one shape we accept

    for (let step = 0; step < MAX_STEPS; step++) {
      const reply: Completion = await this.browser.ask(prompt);
      const raw = reply.text.trim();
      const parsed = parseReply(raw);

      // Nothing usable came back. Two different faults, two different answers:
      // an empty reply is the connection or the backend (its answer, if any, was
      // already looked up on chat.deepseek.com), so ask the same thing again; a
      // reply in some other shape is the model's, so ask for the shape.
      if (parsed == null || (parsed.text === "" && parsed.command === "")) {
        if (raw === "") {
          quiet += 1;
          if (quiet > MAX_RETRIES) {
            throw new Error(
              `Nothing came back from DeepSeek ${quiet} times in a row, so the task stopped here.\n` +
                "No reply arrived and none was stored on the backend, so there is nothing to recover.\n" +
                "Your chat is intact on chat.deepseek.com - send the task again, or use /new.",
            );
          }
          await sleep(RETRY_DELAY_MS * quiet);
        } else {
          garbled += 1;
          if (garbled > MAX_RETRIES) {
            throw new Error(
              'DeepSeek never sent one {"text","command"} object, so the task stopped here.\n' +
                "Its last reply was:\n" +
                raw.slice(0, 400),
            );
          }
          prompt = NUDGE;
        }
        continue;
      }

      quiet = 0;
      garbled = 0;

      // An empty command is the agent's way of saying it is done or blocked.
      if (parsed.command === "") return parsed.text;

      events.onText?.(parsed.text);
      events.onTool?.(parsed.command);
      const result = await runShell(parsed.command, this.cwd);
      events.onToolResult?.(result);
      prompt = `Result:\n${JSON.stringify(result)}`;
    }

    return "Agent stopped: maximum iterations reached.";
  }
}
