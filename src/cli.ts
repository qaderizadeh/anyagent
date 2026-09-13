#!/usr/bin/env node
/**
 * AnyAgent — a small CLI agent on chat.deepseek.com.
 *
 *   anyagent                  pick a session (or start one) and chat
 *   anyagent "task"           run one task and exit
 *   anyagent --new            force a brand-new session
 *   anyagent --session ID     continue a specific session
 *   anyagent --cwd DIR        working directory for bash commands
 *
 * Sessions and messages live on chat.deepseek.com. Nothing is stored locally
 * except the captured credentials in DEEPSEEK_SESSION_JSON.
 */

import { createInterface } from "node:readline/promises";
import * as fs from "node:fs";
import * as path from "node:path";

import { Agent, searchEnabled, thinkingEnabled } from "./agent.js";
import {
  BizError,
  createSession,
  history,
  listSessions,
  loadSession,
  resolveWasmPath,
  verifySession,
  type ChatSession,
  type Session,
} from "./deepseek.js";

const dim = (text: string): string => (process.stdout.isTTY ? `\x1b[2m${text}\x1b[0m` : text);
const bold = (text: string): string => (process.stdout.isTTY ? `\x1b[1m${text}\x1b[0m` : text);

const HELP = `Commands:
  /help       show this
  /sessions   list DeepSeek sessions and switch
  /new        start a new DeepSeek session
  /exit       quit (also Ctrl+C, Ctrl+D)

Usage:
  anyagent                  pick a session and chat
  anyagent "task"           run one task and exit
  anyagent --new            new session
  anyagent --session ID     continue a session
  anyagent --cwd DIR        working directory

Env:
  DEEPSEEK_SESSION_JSON / DEEPSEEK_SESSION_PATH   captured credentials
  DEEPSEEK_MODEL_TYPE        backend model (default: backend default)
  DEEPSEEK_THINKING_ENABLED  deep thinking (default: on)
  DEEPSEEK_SEARCH_ENABLED    web search (default: off)
  DEEPSEEK_MAX_ITERATIONS    loop limit (default: 50)
  DEEPSEEK_SHELL_TIMEOUT_MS  command timeout (default: 120000)`;

type Args = {
  cwd: string;
  session?: string;
  fresh: boolean;
  task?: string;
  help: boolean;
};

let rl: ReturnType<typeof createInterface> | undefined;
let busy = false;

/**
 * Line queue around readline.
 *
 * readline drops lines that arrive while no question is pending (which is
 * exactly what happens when input is piped), so buffer them here instead.
 * `null` means end of input.
 */
const queued: Array<string | null> = [];
const pending: Array<(line: string | null) => void> = [];
let ended = false;

function startInput(): void {
  rl ??= createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  });
  rl.on("line", (line) => {
    const next = pending.shift();
    if (next) next(line);
    else queued.push(line);
  });
  rl.on("close", () => {
    ended = true;
    queued.push(null);
    for (const next of pending.splice(0)) next(null);
  });
  rl.on("SIGINT", () => {
    if (busy) return; // a running command should get the signal instead
    process.stdout.write("\n");
    process.exit(0);
  });
}

function ask(prompt: string): Promise<string | null> {
  startInput();
  process.stdout.write(prompt);
  const buffered = queued.shift();
  if (buffered !== undefined) return Promise.resolve(buffered);
  if (ended) return Promise.resolve(null);
  return new Promise((resolve) => pending.push(resolve));
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cwd: process.cwd(), fresh: false, help: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--cwd" || flag === "-C") args.cwd = argv[++i] ?? args.cwd;
    else if (flag === "--session" || flag === "-s") args.session = argv[++i];
    else if (flag === "--new" || flag === "-n") args.fresh = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else rest.push(flag);
  }
  if (rest.length > 0) args.task = rest.join(" ");
  return args;
}

function when(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "                 ";
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function printSessions(list: ChatSession[]): void {
  console.log(dim("Sessions on chat.deepseek.com:"));
  list.forEach((item, index) => {
    console.log(`  [${index + 1}] ${when(item.updatedAt)}  ${oneLine(item.title, 70)}`);
  });
  console.log("  [0] start a new session\n");
}

/** Newest message id in a chat session — the parent for the next turn. */
async function tipOf(session: Session, chatId: string): Promise<number> {
  const messages = await history(session, chatId).catch(() => []);
  return messages.reduce((max, message) => Math.max(max, message.id), 0);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const cwd = path.resolve(args.cwd);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }

  const session = loadSession();
  await verifySession(session);

  const wasmPath = resolveWasmPath();
  const list = await listSessions(session, 10);

  let chatId: string;
  let parentId = 0;

  if (args.session != null) {
    chatId = args.session;
    parentId = await tipOf(session, chatId);
  } else if (args.fresh || args.task != null) {
    chatId = await createSession(session);
  } else {
    if (list.length > 0) printSessions(list);
    const asked = await ask(list.length > 0 ? "Pick [0]: " : "Start a new session? [y]: ");
    if (asked === null) return;
    const choice = Number(asked.trim() === "" ? "0" : asked.trim());
    const picked =
      Number.isInteger(choice) && choice >= 1 && choice <= list.length
        ? list[choice - 1]!.id
        : undefined;
    chatId = picked ?? (await createSession(session));
    parentId = picked ? await tipOf(session, chatId) : 0;
  }

  console.log(bold("AnyAgent"));
  console.log("────────────────────────────");
  console.log(`${dim("Backend:  ")} chat.deepseek.com (web session)`);
  console.log(`${dim("Session:  ")} ${chatId}`);
  console.log(`${dim("Thinking: ")} ${thinkingEnabled() ? "enabled" : "disabled"}`);
  console.log(`${dim("Search:   ")} ${searchEnabled() ? "enabled" : "disabled"}`);
  console.log(`${dim("Directory:")} ${cwd}`);
  console.log();
  console.log(dim("WARNING: this agent runs bash commands and can modify files."));
  console.log(dim("Only run it in a directory/environment you trust."));
  console.log();

  const agent = new Agent(session, chatId, wasmPath, cwd, parentId || undefined);

  const runTask = async (task: string): Promise<void> => {
    const started = Date.now();
    busy = true;
    let answer: string;
    try {
      answer = await agent.run(task, {
        onTool: (command) => console.log(dim(`  -> shell: ${oneLine(command, 120)}`)),
        onToolResult: (result) =>
          console.log(dim(`     ${result.exitCode === 0 ? "ok" : `exit ${result.exitCode}`}`)),
        onNewSession: () =>
          console.log(dim("  ! the previous DeepSeek session was gone; started a new one")),
      });
    } finally {
      busy = false;
    }
    console.log();
    console.log(answer);
    console.log(dim(`(${((Date.now() - started) / 1000).toFixed(1)}s)`));
  };

  if (args.task != null) {
    await runTask(args.task);
    return;
  }

  console.log(dim("Type a task, or /help.\n"));
  for (;;) {
    const line = await ask("> ");
    if (line === null) break; // Ctrl+D / end of input
    const input = line.trim();
    if (input === "") continue;

    if (!input.startsWith("/")) {
      try {
        await runTask(input);
      } catch (error) {
        console.log();
        console.log(
          error instanceof BizError
            ? `DeepSeek error (${error.code}): ${error.message}`
            : errorText(error),
        );
        console.log(dim("Try again, or /exit to quit."));
      }
      continue;
    }

    const [command] = input.slice(1).split(/\s+/);

    if (command === "exit" || command === "quit") break;

    if (command === "help") {
      console.log(HELP);
      continue;
    }

    if (command === "new") {
      agent.repoint(await createSession(session));
      console.log(dim("Started a new DeepSeek session."));
      continue;
    }

    if (command === "sessions") {
      const fresh = await listSessions(session);
      if (fresh.length === 0) {
        console.log(dim("No sessions on the backend yet."));
        continue;
      }
      printSessions(fresh);
      const asked = await ask("Continue which? [0 = cancel]: ");
      const choice = Number((asked ?? "0").trim());
      if (Number.isInteger(choice) && choice >= 1 && choice <= fresh.length) {
        const chosen = fresh[choice - 1]!;
        agent.repoint(chosen.id, (await tipOf(session, chosen.id)) || undefined);
        console.log(dim(`Continuing "${oneLine(chosen.title, 60)}".`));
      }
      continue;
    }

    console.log(dim(`Unknown command: /${command}`));
  }

  console.log(dim("Bye."));
}

main()
  .then(() => {
    rl?.close();
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.log();
    console.log(errorText(error));
    rl?.close();
    process.exit(1);
  });
