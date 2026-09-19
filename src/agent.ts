/**
 * The agent: a loop, one command, one answer shape.
 *
 *   task -> model -> {"text": "...", "command": "..."} -> run one command -> ...
 *
 * The agent owns the conversation, because Ollama has no memory of its own:
 * every request carries the messages. Everything else is the model's job.
 */

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

import type { Message, Ollama } from "./ollama.js";

const MAX_STEPS = intEnv("ANYAGENT_MAX_ITERATIONS", 50);
const SHELL_TIMEOUT_MS = intEnv("ANYAGENT_SHELL_TIMEOUT_MS", 120_000);
/** How many past messages travel with each request. Local models have small contexts. */
const CONTEXT_MESSAGES = intEnv("ANYAGENT_CONTEXT_MESSAGES", 24);
/** A command's output is clipped: a local model cannot read 30k of it anyway. */
const MAX_OUTPUT_CHARS = 8_000;
/** Extra attempts allowed for a reply we cannot use. */
const MAX_RETRIES = 2;

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

/**
 * The one answer shape, as a system message.
 *
 * Ollama also enforces this as a JSON schema, so the shape is guaranteed; this
 * prompt is what tells the model what the *words* mean.
 */
export function header(cwd: string): string {
  const shell = shellName();
  return [
    `You are a command-line agent on the user's ${OS_NAME} computer. Commands run in ${shell},`,
    `one at a time, starting in ${cwd}.`,
    "You act only by running commands: that is how you inspect this machine and how you change it.",
    "When a task needs something this machine knows - the time, the files, the OS, what is",
    "installed - run a command to find it. Never answer that from memory, and never reply that",
    "you cannot access the machine: you can, by running a command.",
    "Always reply with one JSON object in exactly this shape and nothing else -",
    "no prose, no markdown, no code fence:",
    `{"text": "short note for the user", "command": "the ${shell} command to run"}`,
    'Put "" in "command" only when the task is finished, or when you are truly stuck and need',
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
        const exitCode = failure == null ? 0 : typeof failure.code === "number" ? failure.code : 1;
        // A shell that never started reports itself only in the error, so keep
        // that too - otherwise the failure is just "exit 1" with no reason.
        const missing = failure != null && typeof failure.code === "string" ? failure.message : "";
        const killed = failure?.killed ? `[killed after ${SHELL_TIMEOUT_MS}ms]` : "";
        resolve({
          exitCode,
          stdout: clip(String(stdout)),
          stderr: clip([String(stderr).trim(), missing, killed].filter((part) => part !== "").join("\n")),
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
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Read {"text","command"} out of a reply. Returns null if there is none. */
export function parseReply(reply: string): Reply | null {
  // The schema makes this valid JSON already; older Ollama builds and some
  // models still wrap it in a fence or a sentence, so look inside too.
  const body = reply.replace(/```[a-z]*\s*/gi, "").trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  const wrapped = start >= 0 && end > start ? body.slice(start, end + 1) : body;
  const object = asObject(body) ?? asObject(wrapped);
  if (object === null) return null;

  const field = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
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
    private readonly ollama: Ollama,
    private readonly cwd: string,
    /** The conversation, without the system message. Kept by reference. */
    private readonly messages: Message[],
  ) {}

  get history(): Message[] {
    return this.messages;
  }

  /** What Ollama is asked this turn: the prompt, then the recent conversation. */
  private request(): Message[] {
    return [
      { role: "system", content: header(this.cwd) },
      ...this.messages.slice(-CONTEXT_MESSAGES),
    ];
  }

  async run(task: string, events: AgentEvents = {}): Promise<string> {
    this.messages.push({ role: "user", content: task });
    let unusable = 0;

    for (let step = 0; step < MAX_STEPS; step++) {
      const raw = (await this.ollama.chat(this.request())).trim();
      const parsed = parseReply(raw);

      if (parsed === null || (parsed.text === "" && parsed.command === "")) {
        unusable += 1;
        if (unusable > MAX_RETRIES) {
          throw new Error(
            parsed === null
              ? "The model never answered with one {\"text\",\"command\"} object, so the task stopped here.\n" +
                  `Its last reply was:\n${raw === "" ? "(nothing at all)" : raw.slice(0, 400)}`
              : "The model answered with an empty reply three times in a row, so the task stopped here.\n" +
                  "The conversation is saved - try again, or /new with a smaller model.",
          );
        }
        this.messages.push({ role: "user", content: NUDGE });
        continue;
      }

      unusable = 0;
      this.messages.push({ role: "assistant", content: raw });

      // An empty command is the agent's way of saying it is done or blocked.
      if (parsed.command === "") return parsed.text;

      events.onText?.(parsed.text);
      events.onTool?.(parsed.command);
      const result = await runShell(parsed.command, this.cwd);
      events.onToolResult?.(result);
      this.messages.push({ role: "user", content: `Result:\n${JSON.stringify(result)}` });
    }

    return "Agent stopped: maximum iterations reached.";
  }
}
