/**
 * The agent: a loop, one tool, and a very small tool-call parser.
 *
 *   task -> model -> tool call? -> run bash -> send result -> model -> ...
 *
 * Conversation state is not kept here. It lives in the chat session on
 * chat.deepseek.com; this process only carries the current prompt and the
 * message id to reply to.
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

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Instructions sent as the first message of a new chat session. */
export const TOOL_HEADER = [
  "You are a command-line agent. You act on the user's computer with one tool:",
  "  shell(command) - run one bash command in the working directory.",
  "",
  'To act, reply with ONLY this JSON, one command at a time:',
  '{"tool_calls":[{"id":"1","type":"function","function":{"name":"shell","arguments":{"command":"ls -la"}}}]}',
  "",
  'Each result comes back as {"exitCode":0,"stdout":"...","stderr":"..."}.',
  "Read it, then call the tool again or answer in plain text when the task is done.",
  "Never claim you did something unless a tool result shows it succeeded.",
  "Keep the final answer short.",
].join("\n");

const EMPTY_NUDGE =
  'Your reply was empty. Either call the shell tool, or give your final answer as plain text.';
const UNPARSEABLE_NUDGE =
  "That tool call could not be parsed. Re-send it as valid JSON on a single line:\n" +
  '{"tool_calls":[{"id":"1","type":"function","function":{"name":"shell","arguments":{"command":"..."}}}]}';

const MAX_STUCK_STEPS = 4;

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
/* tool-call parsing                                                   */
/* ------------------------------------------------------------------ */

/** Zero-width characters a model sometimes injects into tag names. */
const INVISIBLE = /[\u200b-\u200f\u2060\ufeff]/g;

/**
 * Loose on purpose: this guard stops raw tool markup being printed as an
 * answer, so it must not depend on exact spelling ("< invoke", "< parameter").
 */
const LOOKS_LIKE_CALL = /tool_calls|<\s*invoke\b|<\s*parameter\b|"arguments"\s*:/i;

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Undo the JSON escaping a model sometimes applies to the whole call. */
function unescapeMarkup(text: string): string {
  return text.replace(/\\(["'/\\])/g, "$1");
}

/** Read a command out of a JSON argument object (or a stringified one). */
function commandFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (typeof parsed === "string") return parsed;
  if (!parsed || typeof parsed !== "object") return null;

  const object = parsed as Record<string, unknown>;
  for (const key of ["command", "cmd", "script", "code"]) {
    if (typeof object[key] === "string") return object[key] as string;
  }
  // The model sometimes wraps the whole argument object one level deep.
  const nested = object["arguments"];
  if (typeof nested === "string") return commandFromJson(nested);
  if (nested && typeof nested === "object") return commandFromJson(JSON.stringify(nested));
  return null;
}

/**
 * Extract the shell commands from a reply.
 *
 * Understands the plain JSON form plus the XML-ish spellings the model
 * occasionally falls back to, including JSON-escaped and HTML-escaped tags.
 */
export function parseCommands(reply: string): string[] {
  const commands: string[] = [];
  const add = (value: string | null): void => {
    const command = (value ?? "").trim();
    if (command !== "" && !commands.includes(command)) commands.push(command);
  };

  const variants = [reply, unescapeMarkup(decodeEntities(reply))].map((text) =>
    text.replace(INVISIBLE, ""),
  );

  for (const variant of variants) {
    if (!LOOKS_LIKE_CALL.test(variant)) continue;

    // {"command": "..."}
    for (const match of variant.matchAll(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      add(commandFromJson(`"${match[1]}"`));
    }
    // {"arguments": {"command": "..."}}
    for (const match of variant.matchAll(/"arguments"\s*:\s*(\{[\s\S]*?\})\s*}/g)) {
      add(commandFromJson(match[1]));
    }
    // <parameter name="command">...</parameter>  (also "< parameter")
    for (const match of variant.matchAll(
      /<\s*parameter[^>]*name\s*=\s*"?command"?[^>]*>([\s\S]*?)<\s*\/\s*parameter\s*>/g,
    )) {
      add(decodeEntities(match[1]));
    }
    // <parameter name="arguments">{"command":"..."}</parameter>
    for (const match of variant.matchAll(
      /<\s*parameter[^>]*name\s*=\s*"?arguments"?[^>]*>([\s\S]*?)<\s*\/\s*parameter\s*>/g,
    )) {
      add(commandFromJson(decodeEntities(match[1])));
    }

    if (commands.length > 0) break;
  }

  return commands;
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
    let prompt = `${TOOL_HEADER}\n\n${task}`;
    let stuck = 0;

    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await this.send(prompt, events);
      const commands = parseCommands(reply.text);

      if (commands.length === 0) {
        const answer = reply.text.trim();

        if (answer !== "" && !LOOKS_LIKE_CALL.test(answer)) return answer;

        stuck += 1;
        if (stuck > MAX_STUCK_STEPS) {
          throw new Error(
            "The model kept replying with an unusable reply. Last one:\n" +
              reply.text.slice(0, 400),
          );
        }
        prompt = answer === "" ? EMPTY_NUDGE : UNPARSEABLE_NUDGE;
        continue;
      }

      stuck = 0;
      const results: ShellResult[] = [];
      for (const command of commands) {
        events.onTool?.(command);
        const result = await runShell(command, this.cwd);
        events.onToolResult?.(result);
        results.push(result);
      }
      prompt = `Tool results:\n${JSON.stringify(results)}`;
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
