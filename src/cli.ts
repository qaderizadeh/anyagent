#!/usr/bin/env node
/**
 * AnyAgent - a small CLI agent on chat.deepseek.com.
 *
 *   anyagent                  pick a session (or start one) and chat
 *   anyagent "task"           run one task and exit
 *   anyagent --new            force a brand-new session
 *   anyagent --session ID     continue a specific session
 *   anyagent --cwd DIR        working directory for the commands
 *
 * Everything runs through a real Chromium, hidden by default. The sign-in is
 * the captured authorization + cookie from DEEPSEEK_SESSION_JSON, put into the
 * browser before the page loads; with no such file the browser profile is used
 * and you sign in once in a visible window. Sessions and messages live on
 * chat.deepseek.com - nothing is stored locally.
 */

import { createInterface } from "node:readline/promises";
import * as fs from "node:fs";
import * as path from "node:path";

import { Agent, shellName } from "./agent.js";
import { Browser, modes, type ChatSession } from "./browser.js";

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
  DEEPSEEK_SESSION_JSON      captured authorization + cookie (or DEEPSEEK_SESSION_PATH)
  ANYAGENT_PROFILE_DIR       browser profile, used when there is no credentials file
  ANYAGENT_HEADLESS          "0" to show the browser window (default: hidden)
  ANYAGENT_BROWSER_PATH      use this Chromium/Chrome instead of the bundled one
  ANYAGENT_PACE_MS           pause before each prompt (default: 300)
  DEEPSEEK_THINKING_ENABLED  deep thinking (default: on)
  DEEPSEEK_SEARCH_ENABLED    web search (default: off)
  DEEPSEEK_MAX_ITERATIONS    loop limit (default: 50)
  ANYAGENT_SHELL             shell to run commands in (default: bash, cmd.exe on Windows)
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
  if (rl) return; // once only: extra "line" listeners re-deliver every line

  rl = createInterface({
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

  const browser = await Browser.open((text) => console.log(dim(text)));
  try {
    await run(args, browser, cwd);
  } finally {
    await browser.close();
  }
}

async function run(args: Args, browser: Browser, cwd: string): Promise<void> {
  const agent = new Agent(browser, cwd);
  const list = await browser.listSessions(10);

  if (args.session != null) {
    await agent.openSession(args.session);
  } else if (args.fresh || args.task != null) {
    await agent.newSession();
  } else {
    if (list.length > 0) printSessions(list);
    const asked = await ask(list.length > 0 ? "Pick [0]: " : "Start a new session? [y]: ");
    if (asked === null) return;
    const choice = Number(asked.trim() === "" ? "0" : asked.trim());
    const picked =
      Number.isInteger(choice) && choice >= 1 && choice <= list.length
        ? list[choice - 1]!.id
        : undefined;
    if (picked === undefined) await agent.newSession();
    else await agent.openSession(picked);
  }

  const { thinking, search } = modes();
  console.log(bold("AnyAgent"));
  console.log("────────────────────────────");
  console.log(`${dim("Backend:  ")} chat.deepseek.com (${browser.mode})`);
  console.log(`${dim("Login:    ")} ${browser.login}`);
  console.log(`${dim("Session:  ")} ${agent.id || "(new chat)"}`);
  console.log(`${dim("Thinking: ")} ${thinking ? "enabled" : "disabled"}`);
  console.log(`${dim("Search:   ")} ${search ? "enabled" : "disabled"}`);
  console.log(`${dim("Shell:    ")} ${shellName()}`);
  console.log(`${dim("Directory:")} ${cwd}`);
  console.log();
  console.log(dim(`WARNING: this agent runs ${shellName()} commands and can modify files.`));
  console.log(dim("Only run it in a directory/environment you trust."));
  console.log();

  const runTask = async (task: string): Promise<void> => {
    const started = Date.now();
    busy = true;
    let answer: string;
    try {
      answer = await agent.run(task, {
        onText: (text) => {
          if (text !== "") console.log(dim(`  · ${oneLine(text, 200)}`));
        },
        onTool: (command) => console.log(dim(`  -> shell: ${oneLine(command, 120)}`)),
        onToolResult: (result) => {
          console.log(dim(`     ${result.exitCode === 0 ? "ok" : `exit ${result.exitCode}`}`));
          // Show why it failed - a shell that never started is otherwise silent.
          const reason = result.stderr.split("\n").find((line) => line.trim() !== "");
          if (result.exitCode !== 0 && reason) console.log(dim(`     ${oneLine(reason, 140)}`));
        },
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
        console.log(errorText(error));
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
      await agent.newSession();
      console.log(dim("Started a new DeepSeek session."));
      continue;
    }

    if (command === "sessions") {
      const fresh = await browser.listSessions();
      if (fresh.length === 0) {
        console.log(dim("No sessions on the backend yet."));
        continue;
      }
      printSessions(fresh);
      const asked = await ask("Continue which? [0 = cancel]: ");
      const choice = Number((asked ?? "0").trim());
      if (Number.isInteger(choice) && choice >= 1 && choice <= fresh.length) {
        const chosen = fresh[choice - 1]!;
        await agent.openSession(chosen.id);
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
