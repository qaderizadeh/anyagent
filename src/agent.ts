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

/** The window is hidden by default, which also hides whatever the page is doing. */
function windowHint(): string {
  const raw = (process.env["ANYAGENT_HEADLESS"] ?? "").trim().toLowerCase();
  const hidden = raw === "" || ["1", "true", "yes", "on"].includes(raw);
  return hidden ? "\nRun with ANYAGENT_HEADLESS=0 to watch the browser window." : "";
}

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const IS_WINDOWS = process.platform === "win32";
const OS_NAME = IS_WINDOWS ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";

/**
 * bash.exe under System32 - or the WindowsApps alias folder - is not a shell at
 * all, it is the WSL launcher. Running a command through it either fails, or
 * hands it to a Linux box that cannot see the Windows working directory. Both
 * look exactly like "the commands never run". A real Git Bash, MSYS2 or Cygwin
 * bash lives somewhere else, and that one works.
 */
export function isWslStub(bashPath: string): boolean {
  return /\\system32\\|\\syswow64\\|\\windowsapps\\/.test(bashPath.toLowerCase().replace(/\//g, "\\"));
}

function onPath(file: string): string | undefined {
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (dir !== "" && existsSync(path.join(dir, file))) return path.join(dir, file);
  }
  return undefined;
}

/** A Windows bash that runs commands in the user's own filesystem, not in WSL. */
function realBash(): string | undefined {
  const roots = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env["LOCALAPPDATA"]]
    .filter((dir): dir is string => Boolean(dir));
  const candidates = [
    ...roots.flatMap((dir) => [
      path.join(dir, "Git", "bin", "bash.exe"),
      path.join(dir, "Programs", "Git", "bin", "bash.exe"),
      path.join(dir, "Git", "usr", "bin", "bash.exe"),
    ]),
    "C:\\msys64\\usr\\bin\\bash.exe",
    "C:\\cygwin64\\bin\\bash.exe",
    "C:\\cygwin\\bin\\bash.exe",
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;

  const found = onPath("bash.exe");
  return found !== undefined && !isWslStub(found) ? found : undefined;
}

function cmdShell(): string {
  return process.env["COMSPEC"] || "cmd.exe";
}

function powershell(): string {
  const installed = [onPath("pwsh.exe"), onPath("powershell.exe")];
  for (const candidate of installed) if (candidate !== undefined) return candidate;
  return path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * The shell commands run in: a real bash where there is one, the Windows command
 * interpreter otherwise. Set ANYAGENT_SHELL to a path or a name to override.
 */
export function resolveShell(): string {
  const configured = (process.env["ANYAGENT_SHELL"] ?? "").trim();
  if (configured !== "") return configured;
  if (IS_WINDOWS) return realBash() ?? cmdShell();
  return "/bin/bash";
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

/** A fence line, and whatever tag follows it. `{.cmd}` and `cmd (Windows)` count. */
const FENCE = /^\s*(`{3,}|~{3,})\s*(.*?)\s*$/;

type Block = { info: string; body: string; raw: string };

/**
 * Tags that mean "run this". A model on Windows writes `cmd` or `powershell`
 * blocks whatever the setup asked for, and ignoring one is indistinguishable
 * from never running anything - so match the name rather than the exact string:
 * `cmd`, `CMD`, `cmd.exe`, `{.cmd}`, `cmd-script` are all the same shell.
 * Anything not named here is text the model is showing us.
 */
const KNOWN_SHELLS = new Set([
  // a Unix shell, by any of its names
  "sh", "bash", "zsh", "fish", "dash", "ash", "ksh", "mksh", "csh", "tcsh", "posix", "shell", "console",
  // and Windows
  "cmd", "bat", "batch", "dos", "win", "windows", "command", "commands", "cmdline",
  "powershell", "pwsh", "ps", "ps1",
]);

const CMD_TAGS = new Set(["cmd", "bat", "batch", "dos", "win", "windows", "command", "commands", "cmdline"]);
const PS_TAGS = new Set(["powershell", "pwsh", "ps", "ps1"]);

/** One tag word without its decoration: ".cmd" -> cmd, "cmd.exe" -> cmd. */
function bare(word: string): string {
  return word
    .replace(/^[#.]+/, "")
    .replace(/\.exe$/, "")
    .replace(/[.]+$/, "")
    .replace(/-(script|session|prompt|file|syntax|shell)$/, "");
}

/** The words of a tag, decoration off: "cmd.exe" -> [cmd], "{.cmd}" -> [cmd]. */
function tagWords(info: string): string[] {
  return info
    .toLowerCase()
    .replace(/[^a-z0-9#.-]+/g, " ")
    .split(" ")
    .map(bare)
    .filter((word) => word !== "");
}

/** The shell a block names, or null when the block is text the model is showing us. */
function shellTag(info: string): string | null {
  if (info.trim() === "") return ""; // a bare fence is still a command
  for (const word of tagWords(info)) if (KNOWN_SHELLS.has(word)) return word;
  return null;
}

/**
 * A block may name a Windows shell instead of the one the setup named. Run it in
 * the shell it asks for rather than ignore it. `undefined` means the default.
 */
export function shellFor(info: string, onWindows: boolean = IS_WINDOWS): string | undefined {
  if (!onWindows) return undefined;
  const words = tagWords(info);
  if (words.some((word) => PS_TAGS.has(word))) return powershell();
  if (words.some((word) => CMD_TAGS.has(word))) return cmdShell();
  return undefined;
}

/**
 * A block copied out of a terminal still has its prompt on it. Drop the "$ " of
 * a Unix prompt, or the "C:\Users\me>" / "PS C:\Users\me>" of a Windows one -
 * neither is part of the command.
 */
const PROMPTS = [/^\s*\$\s+/, /^\s*(?:PS\s+)?[A-Za-z]:\\[^>]*>\s*/];

function stripPrompt(body: string): string {
  const lines = body.split("\n");
  const first = lines.find((line) => line.trim() !== "");
  if (first === undefined) return body;
  for (const prompt of PROMPTS) {
    if (!prompt.test(first)) continue;
    if (!/\S/.test(first.replace(prompt, ""))) return body; // a bare prompt, not a command
    return lines.map((line) => line.replace(prompt, "")).join("\n");
  }
  return body;
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
  // Anything that came off Windows may carry \r\n, and a stray \r on the end of
  // a command makes the shell fail on a name that looks correct.
  const lines = reply.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const kept: string[] = [];
  let open: string | null = null;
  let info = "";
  let body: string[] = [];
  let start = 0;

  const close = (end: number): void => {
    const block: Block = { info, body: body.join("\n"), raw: lines.slice(start, end + 1).join("\n") };
    blocks.push(block);
    if (shellTag(block.info) === null) kept.push(block.raw);
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

export type Command = {
  /** The command to run, or "" when the reply holds none. */
  command: string;
  /** The shell it asked for, when it named one. */
  shell?: string;
};

/** The one command to run this turn, and the shell it wants. */
export function commandStep(reply: string): Command {
  for (const block of split(reply).blocks) {
    const tag = shellTag(block.info);
    if (tag === null) continue;
    return { command: stripPrompt(block.body).trim(), shell: shellFor(tag) };
  }
  return { command: "" };
}

/**
 * Blocks a reply showed us instead of asking us to run them. Worth naming when
 * the reply also ends the task: a block that was passed over and a command that
 * was never executed look the same from the outside.
 */
export function unrunTags(reply: string): string[] {
  return split(reply)
    .blocks.filter((block) => shellTag(block.info) === null)
    .map((block) => block.info);
}

/** The one command to run this turn, or "" when the task is over. */
export function commandIn(reply: string): string {
  return commandStep(reply).command;
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
export function runShell(command: string, cwd: string, shell: string = resolveShell()): Promise<ShellResult> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        shell,
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
  /** Blocks in the closing reply that were shown, not run - so nothing ran. */
  onUnrun?: (tags: string[]) => void;
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
              "Your chat is intact on chat.deepseek.com - send the task again, or use /new." +
              windowHint(),
          );
        }
        await sleep(RETRY_DELAY_MS * quiet);
        continue;
      }
      quiet = 0;

      // No command means the task is over - finished, or blocked and asking
      // for something only a person can do. The whole reply is the answer.
      const step = commandStep(raw);
      if (step.command === "") {
        const unrun = unrunTags(raw);
        if (unrun.length > 0) events.onUnrun?.(unrun);
        return raw;
      }

      events.onReply?.(proseOf(raw));
      events.onCommand?.(step.command);
      const result = await runShell(step.command, this.cwd, step.shell);
      events.onResult?.(result);
      prompt = paste(result);
    }

    return "Agent stopped: maximum iterations reached.";
  }
}
