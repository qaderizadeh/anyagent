/**
 * The agent: a chat with someone who runs the commands you give them.
 *
 *   task -> reply -> a ```bash block -> run it -> paste what it printed -> ...
 *
 * Nothing here tells the model it is an agent holding a tool. It is having an
 * ordinary conversation with a person who works in a terminal and pastes the
 * output back - which is exactly what a person does on chat.deepseek.com. All
 * this file adds is running the block and typing the result back.
 *
 * A reply with no shell block ends the task: either it is finished, or it is
 * blocked and asking for something only a person can do.
 *
 * No conversation state lives here. The chat is the one open in the browser,
 * and everything in it stays on chat.deepseek.com.
 */

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { Browser } from "./browser.js";

const MAX_STEPS = intEnv("DEEPSEEK_MAX_ITERATIONS", 50);
const SHELL_TIMEOUT_MS = intEnv("DEEPSEEK_SHELL_TIMEOUT_MS", 120_000);
const MAX_OUTPUT_CHARS = 30_000;
/** Extra attempts allowed when the backend sends nothing back at all. */
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

/**
 * The one thing a person has to say before the chat makes sense: what machine
 * they are on, where they are, and how they will answer. Sent once, as the
 * first message of a new chat - a person does not re-introduce themselves.
 */
export function setup(cwd: string): string {
  const shell = shellName();
  return [
    `I'm at a ${shell} prompt on my ${OS_NAME} machine, in ${cwd}, and I'll paste back whatever prints.`,
    `Give me one command at a time in a \`\`\`${shell} block. Each one runs in a fresh ${shell} in that`,
    "directory, so chain steps with && when they have to happen together.",
    "Say briefly what each one is for. No block means you are done, or you need me.",
  ].join("\n");
}

export type ShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/* ------------------------------------------------------------------ */
/* the command                                                         */
/* ------------------------------------------------------------------ */

const FENCE = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/;

type Block = { info: string; body: string; raw: string };

/** Fence tags worth running. Anything else is text the model is showing us. */
function isShell(info: string): boolean {
  return info === "" || /^(sh|bash|zsh|shell|dash|ksh|console|posix|sh-script|bash-script)$/.test(info);
}

/** A block copied out of a terminal still has its prompt on it: drop the "$ ". */
function stripPrompt(body: string): string {
  const lines = body.split("\n");
  const first = lines.find((line) => line.trim() !== "");
  if (first === undefined || !/^\s*\$\s+\S/.test(first)) return body;
  return lines.map((line) => line.replace(/^\s*\$\s+/, "")).join("\n");
}

/** Tidy the prose: no runs of blank lines where a command used to be. */
function tidy(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Split a reply into its fenced blocks and the text around them. Any block
 * that is not a command is left in the text - the model may be showing us
 * something, and that is worth seeing.
 */
function split(reply: string): { blocks: Block[]; text: string } {
  const lines = reply.split("\n");
  const blocks: Block[] = [];
  const kept: string[] = [];
  let open: string | null = null;
  let info = "";
  let body: string[] = [];
  let start = 0;

  const close = (end: number): void => {
    const block: Block = { info, body: body.join("\n"), raw: lines.slice(start, end + 1).join("\n") };
    blocks.push(block);
    if (!isShell(block.info)) kept.push(block.raw);
    open = null;
  };

  lines.forEach((line, index) => {
    const match = FENCE.exec(line);
    if (open === null) {
      if (match === null) {
        kept.push(line);
        return;
      }
      open = match[1]!;
      info = match[2]!.toLowerCase();
      body = [];
      start = index;
      return;
    }
    // A closer is a bare fence of the same kind; anything else is content.
    if (match !== null && match[1]![0] === open[0] && match[2] === "") {
      close(index);
      return;
    }
    body.push(line);
  });
  // A fence the model forgot to close is still a block.
  if (open !== null) close(lines.length - 1);

  return { blocks, text: tidy(kept.join("\n")) };
}

/** The one command to run this turn, or "" when the task is over. */
export function commandIn(reply: string): string {
  const block = split(reply).blocks.find((item) => isShell(item.info));
  return block === undefined ? "" : stripPrompt(block.body).trim();
}

/** What the model said while still working, with the commands taken out. */
export function proseOf(reply: string): string {
  return split(reply).text;
}

/* ------------------------------------------------------------------ */
/* what the person types back                                          */
/* ------------------------------------------------------------------ */

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
}

/**
 * The terminal output, as a person would paste it. Output only - they can see
 * which command it belongs to. A failure says so, because a person would.
 */
export function paste(result: ShellResult): string {
  const body = [result.stdout.trim(), result.stderr.trim()]
    .filter((part) => part !== "")
    .join("\n");

  if (result.exitCode === 0) return body === "" ? "(no output)" : body;
  return body === "" ? `(exit code ${result.exitCode})` : `${body}\n(exit code ${result.exitCode})`;
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
        const killed = failure?.killed ? `[stopped after ${SHELL_TIMEOUT_MS}ms]` : "";
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
/* agent                                                              */
/* ------------------------------------------------------------------ */

export type AgentEvents = {
  /** What the model said this turn, with the command taken out. */
  onReply?: (prose: string) => void;
  /** The command we are about to run. */
  onCommand?: (command: string) => void;
  onResult?: (result: ShellResult) => void;
};

export class Agent {
  /** The setup blurb is said at the start of a chat, and only then. */
  private introduced = false;

  constructor(
    private readonly browser: Browser,
    private readonly cwd: string,
  ) {}

  get id(): string {
    return this.browser.currentChatId();
  }

  /** Continue an existing chat. It already has its setup in the history. */
  async openSession(chatId: string): Promise<void> {
    await this.browser.openSession(chatId);
    this.introduced = true;
  }

  /** Start a new chat, which needs the setup again. */
  async newSession(): Promise<void> {
    await this.browser.newSession();
    this.introduced = false;
  }

  async run(task: string, events: AgentEvents = {}): Promise<string> {
    let prompt = this.introduced ? task : `${setup(this.cwd)}\n\n${task}`;
    this.introduced = true;
    let quiet = 0; // nothing came back from the model

    for (let step = 0; step < MAX_STEPS; step++) {
      const raw = (await this.browser.ask(prompt)).text.trim();

      // An empty reply is the backend or the connection, not the model - its
      // answer, if there was one, was already looked up on chat.deepseek.com.
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
        continue;
      }
      quiet = 0;

      // No command means the task is over - finished, or blocked and asking
      // for something only a person can do. The whole reply is the answer.
      const command = commandIn(raw);
      if (command === "") return raw;

      events.onReply?.(proseOf(raw));
      events.onCommand?.(command);
      const result = await runShell(command, this.cwd);
      events.onResult?.(result);
      prompt = paste(result);
    }

    return "Agent stopped: maximum iterations reached.";
  }
}
