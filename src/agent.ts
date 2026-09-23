/**
 * The agent: one conversation loop, and the commands it runs.
 *
 *   task -> model -> prose + maybe one ```sh block -> run it -> paste the
 *   output back -> model -> ... -> a reply with no command is the answer
 *
 * There is no tool schema and no JSON protocol. The model is simply someone in
 * a chat who tells you what to type; this file types it and reports back what
 * happened. Everything else (history, sessions) is on chat.deepseek.com.
 */

import { spawn } from "node:child_process";
import { BizError, complete, createSession, type Completion, type Session } from "./deepseek.js";

/**
 * Said once, as the first message of a chat. It is the whole protocol.
 */
export const STARTER =
  "I’m working in a shell. When a command is needed, give me only one command in a single " +
  "`sh` block at a time; otherwise, don’t include a command block. I’ll run it and paste " +
  "the output back to you.";

const MAX_STEPS = intEnv("DEEPSEEK_MAX_ITERATIONS", 50);
const TIMEOUT_MS = intEnv("DEEPSEEK_SHELL_TIMEOUT_MS", 120_000);
const MAX_OUTPUT = 30_000;
/** Attempts allowed for a reply that came back empty. */
const MAX_EMPTY = 3;
const RETRY_DELAY_MS = 2_000;

const IS_WINDOWS = process.platform === "win32";

/**
 * The shell commands run in: whatever `spawn(..., { shell: true })` uses, which
 * is cmd.exe on Windows and /bin/sh everywhere else. Set ANYAGENT_SHELL to a
 * shell to use that instead (a real bash on Windows, for example).
 */
const SHELL: string | boolean = process.env["ANYAGENT_SHELL"]?.trim() || true;

/** The shell's short name, so the banner can say what commands run in. */
export function shellName(): string {
  const configured = process.env["ANYAGENT_SHELL"]?.trim();
  if (configured) return (configured.split(/[\\/]/).pop() ?? configured).replace(/\.exe$/i, "");
  return IS_WINDOWS ? "cmd" : "sh";
}

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Deep thinking is on by default; web search is off by default. */
export const thinkingEnabled = (): boolean => boolEnv("DEEPSEEK_THINKING_ENABLED", true);
export const searchEnabled = (): boolean => boolEnv("DEEPSEEK_SEARCH_ENABLED", false);

/* ------------------------------------------------------------------ */
/* reading the reply                                                   */
/* ------------------------------------------------------------------ */

/**
 * Fenced blocks, closed or not — a reply that was cut off mid-block still has
 * a command in it. Group 1 is the tag, group 2 the body.
 */
const FENCE = /```([^\n`]*)\r?\n([\s\S]*?)(?:```|$)/g;

/** Tags that are a snippet, not something to type into a shell. */
const NOT_A_COMMAND = new Set([
  "json", "json5", "jsonc", "yaml", "yml", "toml", "ini", "xml", "html", "css", "scss",
  "js", "javascript", "mjs", "cjs", "jsx", "ts", "typescript", "tsx", "vue", "svelte",
  "python", "py", "ruby", "rb", "go", "rust", "rs", "java", "kotlin", "swift", "dart",
  "c", "cpp", "cs", "php", "perl", "lua", "r", "sql", "graphql",
  "diff", "patch", "markdown", "md", "text", "txt", "plaintext", "log", "csv", "env",
]);

/** A copied prompt at the start of a command, so it does not become the command. */
const COPIED_PROMPT = [
  /^[^\S\n]*\$\s+/,
  /^[^\S\n]*>\s+/,
  /^[^\S\n]*PS\s+[A-Za-z]:\\[^>]*>\s*/,
  /^[^\S\n]*[A-Za-z]:\\[^>*\n]*>\s*/,
];

export type Block = { tag: string; body: string };

/** The tag as a plain word: `{.cmd}`, `cmd.exe` and `CMD` are all `cmd`. */
function tagOf(raw: string): string {
  const first = raw.trim().replace(/[{}]/g, " ").trim().split(/\s+/)[0] ?? "";
  return first.toLowerCase().replace(/\.(exe|sh|ps1|bat|cmd)$/, "");
}

export function blocks(reply: string): Block[] {
  const found: Block[] = [];
  for (let match = FENCE.exec(reply); match; match = FENCE.exec(reply)) {
    found.push({ tag: tagOf(match[1] ?? ""), body: (match[2] ?? "").replace(/\r\n/g, "\n").trim() });
  }
  FENCE.lastIndex = 0; // the regex is module-level, so it must not keep state
  return found;
}

/**
 * The one command a reply asks for, if it asks for one. Blocks that are a
 * snippet instead are reported in `skipped`, so a command is never dropped in
 * silence.
 */
export function commandIn(reply: string): { command: string; skipped: string[] } {
  const skipped: string[] = [];
  for (const block of blocks(reply)) {
    if (block.body === "") continue;
    if (NOT_A_COMMAND.has(block.tag)) {
      skipped.push(block.tag);
      continue;
    }
    return { command: clean(block.body), skipped };
  }
  return { command: "", skipped };
}

/** Drop a prompt that got copied in along with the command. */
function clean(command: string): string {
  const lines = command.split("\n");
  const first = lines[0] ?? "";
  for (const pattern of COPIED_PROMPT) {
    if (pattern.test(first)) {
      lines[0] = first.replace(pattern, "");
      break;
    }
  }
  return lines.join("\n").trim();
}

/** The reply with any fenced block taken out — what the model is telling you. */
export function proseOf(reply: string): string {
  return reply
    .replace(/```[^\n`]*\r?\n[\s\S]*?(?:```|$)/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
}

/* ------------------------------------------------------------------ */
/* running one command                                                 */
/* ------------------------------------------------------------------ */

export type ShellResult = { code: number; output: string };

/**
 * Run one command in the working directory and collect everything it printed.
 *
 * `shell: true` hands the command to the platform's own shell, so the same
 * call works on every OS. Nothing here parses the command: whatever the model
 * wrote is exactly what the shell gets.
 */
export function runShell(command: string, cwd: string): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: SHELL, windowsHide: true });
    let output = "";
    let settled = false;

    const finish = (code: number, extra = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let text = extra === "" ? output : output === "" ? extra : `${output}\n${extra}`;
      if (text.length > MAX_OUTPUT) {
        text = `${text.slice(0, MAX_OUTPUT)}\n... [truncated ${text.length - MAX_OUTPUT} chars]`;
      }
      resolve({ code, output: text });
    };

    // Both streams land in one buffer in the order they arrive — the same thing
    // a person sees in a terminal.
    const collect = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT) output += chunk.toString();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(124, `[killed after ${TIMEOUT_MS}ms]`);
    }, TIMEOUT_MS);

    child.on("error", (error: Error) => finish(127, error.message));
    child.on("close", (code: number | null) => finish(code ?? 1));
  });
}

/** What gets pasted back to the model — the output, then the exit code. */
export function pasteBack(result: ShellResult): string {
  const body = result.output.trim() === "" ? "(no output)" : result.output.replace(/\s+$/, "");
  return `${body}\nProcess exited with ${result.code}`;
}

/* ------------------------------------------------------------------ */
/* the loop                                                            */
/* ------------------------------------------------------------------ */

export type AgentEvents = {
  /** A note the model wrote before the command it asked for. */
  onCommand?: (command: string) => void;
  onResult?: (result: ShellResult) => void;
  onComment?: (text: string) => void;
  /** The backend lost the chat, so a fresh one was started. */
  onNewSession?: (chatId: string) => void;
};

export class Agent {
  private parentId?: number | string;
  /** The starter is said once per chat, and again after a switch. */
  private introduced = false;

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

  /** Point this agent at another chat (used by /new and /sessions). */
  repoint(chatId: string, parentId?: number | string): void {
    this.chatId = chatId;
    this.parentId = parentId;
    this.introduced = false;
  }

  async run(task: string, events: AgentEvents = {}): Promise<string> {
    let prompt = this.introduced ? task : `${STARTER}\n\n${task}`;
    this.introduced = true;
    let empty = 0;

    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await this.send(prompt, events);
      const raw = reply.text;

      // Nothing at all came back: a backend hiccup, not a failure of the last
      // command, and its answer (if any) was already looked up on the backend.
      if (raw.trim() === "") {
        empty += 1;
        if (empty >= MAX_EMPTY) {
          throw new Error(
            `DeepSeek sent an empty reply ${empty} times in a row, so the task stopped here.\n` +
              "Nothing came back from the model - this is a backend hiccup, not a command failure.\n" +
              "The chat is intact on chat.deepseek.com - send the task again, or use /new.",
          );
        }
        await new Promise((done) => setTimeout(done, RETRY_DELAY_MS * empty));
        continue;
      }
      empty = 0;

      const { command, skipped } = commandIn(raw);
      // No command means the task is finished, or the model needs an answer
      // from you. Either way the reply is what you get.
      if (command === "") return final(raw, skipped);

      const note = proseOf(raw);
      if (note !== "") events.onComment?.(note);
      events.onCommand?.(command);

      const result = await runShell(command, this.cwd);
      events.onResult?.(result);
      prompt = pasteBack(result);
    }

    return "Agent stopped: maximum iterations reached.";
  }

  /**
   * One message. A stale message id or a chat that no longer exists on the
   * backend is recovered once, then the error is real.
   */
  private async send(prompt: string, events: AgentEvents): Promise<Completion> {
    try {
      return await this.turn(prompt);
    } catch (error) {
      if (error instanceof BizError && error.code === 26) {
        this.parentId = undefined; // the parent message is gone; branch from the end
        return this.turn(prompt);
      }
      if (error instanceof BizError && error.code === 1) {
        this.chatId = await createSession(this.session); // the chat itself was deleted
        this.parentId = undefined;
        events.onNewSession?.(this.chatId);
        return this.turn(`(The previous chat is gone, so this is a new one. Continue the task.)\n\n${prompt}`);
      }
      throw error;
    }
  }

  private async turn(prompt: string): Promise<Completion> {
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
    // An empty reply is announced with an id that is never stored, so keeping
    // it would only produce a stale parent on the next message.
    if (reply.messageId && reply.text.trim() !== "") this.parentId = reply.messageId;
    return reply;
  }
}

/** The final answer, with a note about any block that was shown but not run. */
function final(reply: string, skipped: string[]): string {
  const text = reply.trim();
  if (skipped.length === 0) return text;
  return `${text}\n\n[not run: the \`\`\`${skipped.join("`, ```")} block was a snippet, not a command]`;
}
