/**
 * The agent: a loop, one command, one answer shape.
 *
 *   task -> model -> {"text": "...", "command": "..."} -> run bash -> ...
 *
 * Conversation state is not kept here. It lives in the chat session on
 * chat.deepseek.com; this process only carries the prompt and the message
 * id to reply to.
 */

import { exec } from "node:child_process";
import {
  BizError,
  complete,
  createSession,
  type Completion,
  type Session,
} from "./deepseek.js";

const MAX_STEPS = intEnv("DEEPSEEK_MAX_ITERATIONS", 50);
const SHELL_TIMEOUT_MS = intEnv("DEEPSEEK_SHELL_TIMEOUT_MS", 120_000);
const MAX_OUTPUT_CHARS = 30_000;
/** Extra attempts allowed for an empty or unreadable reply. */
const MAX_RETRIES = 2;

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** The one answer shape. Sent with every task, so it wins over older history. */
export const HEADER = [
  "You are a command-line agent on the user's computer. Run one bash command at a time.",
  "Always reply with one JSON object in exactly this shape and nothing else -",
  "no prose, no markdown, no code fence:",
  '{"text": "short note for the user", "command": "the bash command to run"}',
  'Put "" in "command" when the task is done, or when you are blocked and need',
  'the user to do something - explain that in "text".',
  "Never claim something worked unless a command result showed it.",
].join("\n");

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

/** Run one bash command and always resolve with its exit code and output. */
export function runShell(command: string, cwd: string): Promise<ShellResult> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, shell: "/bin/bash", timeout: SHELL_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const failure = error as (Error & { code?: number | string; killed?: boolean }) | null;
        const exitCode =
          failure == null ? 0 : typeof failure.code === "number" ? failure.code : 1;
        const killed = failure?.killed ? `\n[killed after ${SHELL_TIMEOUT_MS}ms]` : "";
        resolve({
          exitCode,
          stdout: clip(String(stdout)),
          stderr: clip(String(stderr) + killed),
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
  onTool?: (command: string) => void;
  onToolResult?: (result: ShellResult) => void;
  /** The backend lost the chat session, so a fresh one was created. */
  onNewSession?: (chatId: string) => void;
};

export class Agent {
  private parentId?: number | string;

  constructor(
    private readonly session: Session,
    private chatId: string,
    private readonly wasmPath: string,
    private readonly cwd: string,
    parentId?: number | string,
  ) {
    this.parentId = parentId;
  }

  get id(): string {
    return this.chatId;
  }

  /** Point this agent at another chat session (used by /new and /sessions). */
  repoint(chatId: string, parentId?: number | string): void {
    this.chatId = chatId;
    this.parentId = parentId;
  }

  async run(task: string, events: AgentEvents = {}): Promise<string> {
    let prompt = `${HEADER}\n\nTask: ${task}`;
    let retries = 0;

    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await this.send(prompt, events);
      const parsed = parseReply(reply.text);

      // No usable object, or one with nothing in it: ask once more, then stop.
      if (parsed == null || (parsed.text === "" && parsed.command === "")) {
        retries += 1;
        if (retries > MAX_RETRIES) {
          throw new Error(
            "DeepSeek did not send a usable reply, so the task stopped here.\n" +
              "The conversation is intact on chat.deepseek.com - send the task again, or use /new.",
          );
        }
        prompt = NUDGE;
        continue;
      }

      // An empty command is the agent's way of saying it is done or blocked.
      if (parsed.command === "") return parsed.text;

      retries = 0;
      events.onTool?.(parsed.command);
      const result = await runShell(parsed.command, this.cwd);
      events.onToolResult?.(result);
      prompt = `Result:\n${JSON.stringify(result)}`;
    }

    return "Agent stopped: maximum iterations reached.";
  }

  /**
   * One model turn. A stale message id or a chat session that no longer
   * exists on the backend is recovered once, then the error is real.
   */
  private async send(prompt: string, events: AgentEvents): Promise<Completion> {
    try {
      return await this.completeTurn(prompt);
    } catch (error) {
      if (error instanceof BizError && error.code === 26) {
        // The parent message id is gone from this chat; branch from the end.
        this.parentId = undefined;
        return this.completeTurn(prompt);
      }
      if (error instanceof BizError && error.code === 1) {
        // The chat session itself was deleted on DeepSeek's side.
        this.chatId = await createSession(this.session);
        this.parentId = undefined;
        events.onNewSession?.(this.chatId);
        return this.completeTurn(
          `(The previous chat session no longer exists, so this is a new one. Continue the task.)\n\n${prompt}`,
        );
      }
      throw error;
    }
  }

  private async completeTurn(prompt: string): Promise<Completion> {
    const reply = await complete(
      this.session,
      {
        chatId: this.chatId,
        prompt,
        parentId: this.parentId,
        thinking: thinkingEnabled(),
        search: searchEnabled(),
        modelType: process.env["DEEPSEEK_MODEL_TYPE"] || undefined,
      },
      this.wasmPath,
    );
    if (reply.messageId) this.parentId = reply.messageId;
    return reply;
  }
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Deep thinking is on by default; web search is off by default. */
export function thinkingEnabled(): boolean {
  return boolEnv("DEEPSEEK_THINKING_ENABLED", true);
}

export function searchEnabled(): boolean {
  return boolEnv("DEEPSEEK_SEARCH_ENABLED", false);
}
