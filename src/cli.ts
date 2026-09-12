#!/usr/bin/env node
/**
 * AnyAgent — interactive CLI for the agent (anydev.ir).
 *
 *   anyagent                 start an interactive session
 *   anyagent "task"          run a single task and exit
 *   anyagent --resume        continue the most recent saved session
 *   anyagent --session ID    continue a specific saved session
 *   anyagent --cwd ./dir ... set the agent working directory
 *
 * Conversations are saved under ~/.anyagent/sessions/ so any session can be
 * listed and resumed later.
 */

import { createInterface } from "node:readline/promises";
import * as path from "node:path";
import * as fs from "node:fs";

import { Agent } from "./agent.js";
import { Model, ModelError, type ChatMessage } from "./model.js";
import {
  loadSession,
  resolvePowWasmPath,
  type DeepseekSession,
} from "./deepseek.js";
import { abortActiveCommand, tools } from "./tools.js";
import {
  listSessions,
  loadSessionData,
  saveSessionData,
  newSessionId,
  type SessionData,
  type SessionMeta,
} from "./sessions.js";

const HELP_TEXT = `Commands:
  /help      show this help
  /sessions  list saved sessions and switch to one
  /new       start a brand-new session
  /clear     forget the current conversation
  /exit      quit (also: Ctrl+C, Ctrl+D)

While a task is running, Ctrl+C stops the current shell command and keeps
 the session alive, so the agent can see what failed and try again.

Usage:
  anyagent                 start an interactive session
  anyagent "task"          run a single task and exit
  anyagent --resume        continue the most recent saved session
  anyagent --session ID    continue a specific saved session
  anyagent --cwd DIR ...   set the agent working directory

Env:
  DEEPSEEK_SESSION_PATH / DEEPSEEK_SESSION_JSON   DeepSeek web session
  DEEPSEEK_POW_WASM_PATH    path to sha3_wasm_bg.wasm (default ./sha3_wasm_bg.wasm)
  DEEPSEEK_MODEL_TYPE       e.g. deepseek-reasoner (default: backend default)
  DEEPSEEK_THINKING_ENABLED 1/true to enable deep thinking (default: enabled)
  DEEPSEEK_SEARCH_ENABLED   1/true to allow web search (default: disabled)
  DEEPSEEK_MAX_ITERATIONS   max agent loop iterations (default 50)
  DEEPSEEK_SHELL_TIMEOUT_MS shell command timeout in ms (default 120000)
  ANYAGENT_SESSIONS_DIR     where sessions are stored (default ~/.anyagent/sessions)`;

/* ------------------------------------------------------------------ */
/* Colors — plain ANSI, no TUI framework, works in any terminal/SSH.   */
/* ------------------------------------------------------------------ */

const useColor =
  process.stdout.isTTY &&
  process.env["NO_COLOR"] == null &&
  process.env["TERM"] !== "dumb";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
} as const;

function paint(code: string, text: string): string {
  return useColor ? `${code}${text}${ANSI.reset}` : text;
}
const bold = (t: string) => paint(ANSI.bold, t);
const dim = (t: string) => paint(ANSI.dim, t);
const cyan = (t: string) => paint(ANSI.cyan, t);
const green = (t: string) => paint(ANSI.green, t);
const red = (t: string) => paint(ANSI.red, t);
const yellow = (t: string) => paint(ANSI.yellow, t);

/* ------------------------------------------------------------------ */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

/** Parse a boolean env var: "1", "true", "yes", "on" → true; default otherwise. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

/** Keep activity lines readable: one line, and not absurdly long. */
const MAX_PREVIEW_CHARS = 200;

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_PREVIEW_CHARS
    ? `${oneLine.slice(0, MAX_PREVIEW_CHARS - 1)}…`
    : oneLine;
}

/** Short human label for a tool call, used in activity lines. */
function describeToolCall(name: string, args?: Record<string, unknown>): string {
  if (name === "shell" && args?.command != null) return preview(String(args.command));
  if (!args) return "";
  return preview(JSON.stringify(args));
}

/**
 * Render the outcome of a tool call. A command that timed out, was
 * interrupted, or exited non-zero is a failure — even though the tool
 * itself returned normally (the model gets to decide what to do next).
 */
function describeToolOutcome(ok: boolean, result?: unknown): { failed: boolean; note: string } {
  if (!ok) return { failed: true, note: "" };
  const r = (result ?? {}) as { exitCode?: unknown; timedOut?: unknown; interrupted?: unknown };
  if (r.interrupted === true) return { failed: true, note: dim(" (interrupted)") };
  if (r.timedOut === true) return { failed: true, note: dim(" (timed out)") };
  if (typeof r.exitCode === "number" && r.exitCode !== 0) {
    return { failed: true, note: dim(` (exit ${r.exitCode})`) };
  }
  return { failed: false, note: "" };
}

function printBanner(model: Model, cwd: string): void {
  console.log(bold(cyan("AnyAgent")));
  console.log(dim("────────────────────────────"));
  console.log(`Backend:   chat.deepseek.com (direct, no API key)`);
  console.log(`Model:     ${model.modelType ?? "default (chat.deepseek.com)"}`);
  console.log(`Thinking:  ${model.thinkingEnabled ? green("enabled") : "disabled"}`);
  console.log(`Search:    ${model.searchEnabled ? green("enabled") : "disabled"}`);
  console.log(`Directory: ${cwd}`);
  console.log();
  console.log(yellow("WARNING: this agent executes shell commands and can modify files."));
  console.log(yellow("Only run it in a directory/environment you trust."));
  console.log();
}

function makeAgent(
  model: Model,
  cwd: string,
  maxIterations: number,
  messages?: ChatMessage[],
): Agent {
  return new Agent({
    model,
    tools,
    cwd,
    maxIterations,
    messages,
    onToolCallStart: (name, args) => {
      const label = describeToolCall(name, args);
      console.error(`  ${dim("→")} ${dim(`${name}${label ? `: ${label}` : ""}`)}`);
    },
    onToolCallFinish: (name, ok, result) => {
      const { failed, note } = describeToolOutcome(ok, result);
      console.error(`  ${failed ? red("✗") : green("✓")} ${name}${note}`);
    },
  });
}

function modelFromSession(session: DeepseekSession): Model {
  return new Model({
    session,
    powWasmPath: resolvePowWasmPath(),
    modelType: process.env["DEEPSEEK_MODEL_TYPE"] || undefined,
    thinkingEnabled: envBool("DEEPSEEK_THINKING_ENABLED", true),
    searchEnabled: envBool("DEEPSEEK_SEARCH_ENABLED", false),
  });
}

type ParsedArgs = {
  cwd: string;
  task?: string;
  resume: boolean;
  sessionId?: string;
  help: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    cwd: process.cwd(),
    resume: false,
    help: false,
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--resume") {
      result.resume = true;
    } else if (arg === "--session") {
      const value = argv[++i];
      if (value == null) throw new Error("--session requires a session id.");
      result.sessionId = value;
    } else if (arg.startsWith("--session=")) {
      result.sessionId = arg.slice("--session=".length);
    } else if (arg === "--cwd") {
      const value = argv[++i];
      if (value == null) throw new Error("--cwd requires a directory argument.");
      result.cwd = path.resolve(process.cwd(), value);
    } else if (arg.startsWith("--cwd=")) {
      result.cwd = path.resolve(process.cwd(), arg.slice("--cwd=".length));
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length > 0) {
    result.task = positionals.join(" ");
  }
  return result;
}

async function checkCwd(cwd: string): Promise<void> {
  try {
    const stat = await fs.promises.stat(cwd);
    if (!stat.isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    console.error(`Working directory does not exist or is not a directory: ${cwd}`);
    process.exit(1);
  }
}

async function runSingleTask(
  agent: Agent,
  model: Model,
  task: string,
): Promise<number> {
  try {
    const answer = await agent.run(task);
    process.stdout.write(answer + "\n");
    return 0;
  } catch (error) {
    if (error instanceof ModelError) {
      console.error(red(error.message));
    } else {
      console.error(red(error instanceof Error ? error.message : String(error)));
    }
    return 1;
  }
}

/** Ask the user to pick one of the listed sessions (or start a new one). */
async function pickSession(
  sessions: SessionMeta[],
  nextLine: () => Promise<string | null>,
): Promise<SessionMeta | null> {
  console.log("Previous sessions:");
  sessions.forEach((s, i) => {
    const when = s.updatedAt.slice(0, 16).replace("T", " ");
    console.log(`  [${i + 1}] ${dim(when)}  ${yellow(`"${s.title}"`)}  ${dim(`(${s.messageCount} msgs)`)}`);
  });
  console.log("  [0] start a new session");
  process.stdout.write(bold("Pick a session [0]: "));
  const raw = await nextLine();
  if (raw == null) return null;
  const n = Number.parseInt(raw.trim(), 10);
  if (Number.isInteger(n) && n >= 1 && n <= sessions.length) {
    return sessions[n - 1];
  }
  return null;
}

type SessionState = {
  id: string;
  title: string;
  createdAt: string;
};

async function runInteractive(
  model: Model,
  cwd: string,
  maxIterations: number,
  opts: { resume: boolean; sessionId?: string },
): Promise<number> {
  printBanner(model, cwd);

  // Create the readline interface up front and attach a line listener
  // immediately, so piped input (printf ... | anyagent) is never lost while
  // we await session loading below. Lines are queued and consumed one at a
  // time; EOF resolves pending readers with null.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const inbox: string[] = [];
  const waiters: ((line: string | null) => void)[] = [];
  let eof = false;
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else inbox.push(line);
  });
  rl.on("close", () => {
    eof = true;
    for (const waiter of waiters.splice(0)) waiter(null);
  });
  const nextLine = (): Promise<string | null> => {
    if (inbox.length > 0) return Promise.resolve(inbox.shift()!);
    if (eof) return Promise.resolve(null);
    return new Promise((resolve) => {
      waiters.push((line) => resolve(line ?? null));
    });
  };

  // Exit cleanly, killing whatever shell command is still running so we
  // never leave orphaned processes behind.
  const shutdown = (code: number, reason: string): void => {
    abortActiveCommand();
    rl.close();
    console.log();
    console.log(`Bye.${dim(` (${reason})`)}`);
    process.exit(code);
  };

  // Register signal handling before anything can block on input (session
  // loading, the session picker). With a TTY, readline owns the terminal:
  // Ctrl+C arrives as 'SIGINT' on the interface, never as a process signal,
  // and with no listener readline silently pauses input — so the interface
  // listener has to exist from the very first prompt.
  //
  // Ctrl+C stops the command that is running, if any, and the session stays
  // alive so the model can see the failure and try something else. At the
  // prompt it quits.
  rl.on("SIGINT", () => {
    if (abortActiveCommand()) {
      console.error();
      console.error(dim("  ■ stopped the running command (Ctrl+C again to quit)"));
      return;
    }
    shutdown(130, "Ctrl+C");
  });

  // Piped input (no TTY) delivers a real process signal instead.
  process.on("SIGINT", () => shutdown(130, "SIGINT"));
  process.on("SIGTERM", () => shutdown(143, "SIGTERM"));
  process.on("SIGHUP", () => shutdown(129, "SIGHUP"));
  process.on("uncaughtException", (error) => {
    console.error(red(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(red(reason instanceof Error ? reason.message : String(reason)));
    process.exit(1);
  });

  // Pick which session to start with (unless --resume/--session said so).
  let state: SessionState;
  let agent: Agent;

  const sessions = await listSessions();
  const startResumed = (data: SessionData) => {
    state = { id: data.id, title: data.title, createdAt: data.createdAt };
    agent = makeAgent(model, cwd, maxIterations, data.messages);
    console.log(yellow(`Resuming session ${state.id}: "${state.title}"`));
  };
  const startNew = () => {
    state = { id: newSessionId(), title: "", createdAt: new Date().toISOString() };
    agent = makeAgent(model, cwd, maxIterations);
  };

  if (opts.sessionId) {
    const data = await loadSessionData(opts.sessionId);
    if (data) startResumed(data);
    else {
      console.error(red(`Session not found: ${opts.sessionId}`));
      startNew();
    }
  } else if (opts.resume) {
    const data = sessions.length > 0 ? await loadSessionData(sessions[0].id) : null;
    if (data) startResumed(data);
    else {
      console.log(dim("No saved sessions — starting fresh."));
      startNew();
    }
  } else if (sessions.length > 0) {
    const picked = await pickSession(sessions, nextLine);
    const data = picked ? await loadSessionData(picked.id) : null;
    if (data) startResumed(data);
    else startNew();
  } else {
    startNew();
  }
  console.log();

  const persist = async (): Promise<void> => {
    try {
      const messages = agent.snapshot();
      await saveSessionData({
        id: state.id,
        title: state.title,
        createdAt: state.createdAt,
        updatedAt: new Date().toISOString(),
        messageCount: messages.length,
        messages,
      });
    } catch (error) {
      console.error(dim(`(could not save session: ${error instanceof Error ? error.message : String(error)})`));
    }
  };

  const switchToSession = async (id: string | null): Promise<void> => {
    await persist();
    if (id == null) {
      startNew();
      console.log(dim("Started a new session."));
    } else {
      const data = await loadSessionData(id);
      if (!data) {
        console.error(red(`Session not found: ${id}`));
        return;
      }
      startResumed(data);
      console.log(yellow(`Switched to session ${state.id}: "${state.title}"`));
    }
  };

  const handleLine = async (rawLine: string): Promise<boolean> => {
    const input = rawLine.trim();
    if (input === "") return false;

    if (input === "/help") {
      console.log(HELP_TEXT);
      return false;
    }
    if (input === "/clear") {
      agent.reset();
      console.log("Conversation cleared.");
      return false;
    }
    if (input === "/new") {
      await switchToSession(null);
      return false;
    }
    if (input === "/sessions") {
      const all = await listSessions();
      if (all.length === 0) {
        console.log(dim("No saved sessions yet."));
        return false;
      }
      const picked = await pickSession(all, nextLine);
      if (picked) await switchToSession(picked.id);
      return false;
    }
    if (input === "/exit" || input === "/quit") {
      return true;
    }
    if (input.startsWith("/")) {
      console.log(`Unknown command: ${input} (type /help for help)`);
      return false;
    }

    if (!state.title) state.title = input.slice(0, 60);

    try {
      const started = Date.now();
      const answer = await agent.run(input);
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log();
      console.log(answer);
      console.log(dim(`(${elapsed}s)`));
    } catch (error) {
      console.error();
      if (error instanceof ModelError) {
        console.error(red(error.message));
      } else {
        console.error(red(error instanceof Error ? error.message : String(error)));
      }
      console.error("Try again, or type /exit to quit.");
    }

    await persist();
    return false;
  };

  // Main loop. The queue-based nextLine keeps lines typed while a task is
  // still running buffered, so they are processed afterwards in order.
  for (;;) {
    process.stdout.write(bold("> "));
    const line = await nextLine();
    if (line == null) break; // EOF (e.g. Ctrl+D)
    const shouldExit = await handleLine(line);
    if (shouldExit) break;
  }

  rl.close();
  console.log("Bye.");
  return 0;
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(red(error instanceof Error ? error.message : String(error)));
    console.error("Try --help.");
    process.exit(1);
  }

  if (parsed.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  await checkCwd(parsed.cwd);

  let session: DeepseekSession;
  try {
    const loaded = await loadSession();
    session = {
      token: loaded.token ?? "",
      cookies: loaded.cookies ?? {},
      user_agent: loaded.user_agent ?? "",
      client_headers: loaded.client_headers,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(message));
    console.error("\nOnce the session is in place, run anyagent again.");
    process.exit(1);
  }

  const model = modelFromSession(session);

  // Verify the session actually works against chat.deepseek.com.
  try {
    await model.healthCheck();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(message));
    console.error("\nOnce the session is in place, run anyagent again.");
    process.exit(1);
  }

  const maxIterations = envInt("DEEPSEEK_MAX_ITERATIONS", 50);

  if (parsed.task) {
    const agent = makeAgent(model, parsed.cwd, maxIterations);
    const code = await runSingleTask(agent, model, parsed.task);
    if (code === 0) {
      // Record the single run as a session so it can be continued later.
      try {
        const messages = agent.snapshot();
        const id = newSessionId();
        await saveSessionData({
          id,
          title: parsed.task.slice(0, 60),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messageCount: messages.length,
          messages,
        });
        console.log(dim(`Session saved as ${id} — continue later with: anyagent --session ${id}`));
      } catch {
        // saving is best-effort
      }
    }
    process.exit(code);
  }

  await runInteractive(model, parsed.cwd, maxIterations, {
    resume: parsed.resume,
    sessionId: parsed.sessionId,
  });
  process.exit(0);
}

main().catch((error) => {
  console.error(red(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});