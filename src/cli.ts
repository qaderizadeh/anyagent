#!/usr/bin/env node
/**
 * AnyAgent - a small CLI agent on Ollama.
 *
 *   anyagent                  pick a conversation (or start one) and chat
 *   anyagent "task"           run one task and exit
 *   anyagent --new            start a new conversation
 *   anyagent --session ID     continue a conversation
 *   anyagent --model NAME     use a specific model
 *   anyagent --cwd DIR        working directory for the commands
 *
 * The model runs on your own machine through Ollama. Conversations are saved as
 * small JSON files under ~/.anyagent/sessions; nothing is sent anywhere except
 * to your Ollama.
 */

import { createInterface } from "node:readline/promises";
import * as fs from "node:fs";
import * as path from "node:path";

import { Agent, shellName } from "./agent.js";
import { Ollama, baseUrl, thinkingLabel } from "./ollama.js";
import {
  listSessions,
  newSession,
  readSession,
  saveSession,
  titleFor,
  type Session,
  type SessionMeta,
} from "./sessions.js";

const dim = (text: string): string => (process.stdout.isTTY ? `\x1b[2m${text}\x1b[0m` : text);
const bold = (text: string): string => (process.stdout.isTTY ? `\x1b[1m${text}\x1b[0m` : text);

const HELP = `Commands:
  /help       show this
  /sessions   list saved conversations and switch
  /new        start a new conversation
  /exit       quit (also Ctrl+C, Ctrl+D)

Usage:
  anyagent                  pick a conversation and chat
  anyagent "task"           run one task and exit
  anyagent --new            new conversation
  anyagent --session ID     continue a conversation
  anyagent --model NAME     use a specific model
  anyagent --cwd DIR        working directory

Env:
  OLLAMA_URL                 where Ollama listens (default ${baseUrl()})
  OLLAMA_MODEL               model to use (default: ask, or the only one installed)
  OLLAMA_TIMEOUT_MS          how long one reply may take (default 300000)
  ANYAGENT_THINKING          1/0 to force thinking mode (default: the model's own)
  ANYAGENT_SHELL             shell to run commands in (default: bash, cmd.exe on Windows)
  ANYAGENT_MAX_ITERATIONS    loop limit per task (default: 50)
  ANYAGENT_SHELL_TIMEOUT_MS  per-command timeout (default: 120000)
  ANYAGENT_CONTEXT_MESSAGES  history sent with each request (default: 24)
  ANYAGENT_SESSIONS_DIR      where conversations are saved (default ~/.anyagent/sessions)`;

type Args = {
  cwd: string;
  session?: string;
  model?: string;
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
    else if (flag === "--model" || flag === "-m") args.model = argv[++i];
    else if (flag === "--new" || flag === "-n") args.fresh = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else rest.push(flag);
  }
  if (rest.length > 0) args.task = rest.join(" ");
  return args;
}

function when(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "                 ";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printSessions(list: SessionMeta[]): void {
  console.log(dim("Saved conversations:"));
  list.forEach((item, index) => {
    console.log(
      `  [${index + 1}] ${when(item.updatedAt)}  ${oneLine(item.title, 60)}  (${item.count} msgs)`,
    );
  });
  console.log("  [0] start a new conversation\n");
}

/**
 * Which model to use: the one you named, the only one installed, or a choice.
 * Ollama's own "model not found" is late and vague, so this catches it early.
 */
async function resolveModel(requested: string | undefined, interactive: boolean): Promise<string> {
  const installed = await Ollama.models();
  const wanted = (requested ?? process.env["OLLAMA_MODEL"] ?? "").trim();
  const known = (name: string): boolean =>
    installed.length === 0 || installed.includes(name) || installed.some((item) => item.startsWith(`${name}:`));

  if (wanted !== "") {
    if (!known(wanted)) {
      throw new Error(
        `Ollama does not have the model "${wanted}".\n\n` +
          `Installed models:\n${installed.map((name) => `  ${name}`).join("\n")}\n\n` +
          `Pull it first:\n  ollama pull ${wanted}`,
      );
    }
    return wanted;
  }

  if (installed.length === 0) {
    throw new Error(
      "Ollama has no models installed.\n\nPull one first:\n  ollama pull llama3.2",
    );
  }
  if (installed.length === 1 || !interactive) return installed[0]!;

  console.log(dim("Models installed:"));
  installed.forEach((name, index) => console.log(`  [${index + 1}] ${name}`));
  console.log();
  const picked = await ask(`Pick a model [1]: `);
  const choice = Number((picked ?? "1").trim() === "" ? "1" : (picked ?? "1").trim());
  return installed[Number.isInteger(choice) && choice >= 1 && choice <= installed.length ? choice - 1 : 0]!;
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

  const model = await resolveModel(args.model, args.task == null);
  const ollama = new Ollama(model);

  let session: Session;
  if (args.session != null) {
    const found = readSession(args.session);
    if (found === null) {
      const saved = listSessions();
      throw new Error(
        `No saved conversation "${args.session}".\n\n` +
          (saved.length > 0
            ? `Saved conversations:\n${saved.map((item) => `  ${item.id}  ${oneLine(item.title, 50)}`).join("\n")}`
            : "There are none yet - run anyagent without --session to start one."),
      );
    }
    session = found;
  } else if (args.fresh || args.task != null) {
    session = newSession();
  } else {
    const saved = listSessions();
    let picked: string | undefined;
    if (saved.length > 0) {
      printSessions(saved);
      const choice = Number(((await ask("Pick [0]: ")) ?? "0").trim() || "0");
      if (Number.isInteger(choice) && choice >= 1 && choice <= saved.length) {
        picked = saved[choice - 1]!.id;
      }
    } else {
      const start = await ask("Start a new conversation? [y]: ");
      if (start === null) return;
    }
    session = picked === undefined ? newSession() : (readSession(picked) ?? newSession());
  }

  let agent = new Agent(ollama, cwd, session.messages);

  console.log(bold("AnyAgent"));
  console.log("────────────────────────────");
  console.log(`${dim("Backend:  ")} Ollama at ${ollama.url}`);
  console.log(`${dim("Model:    ")} ${model}`);
  console.log(`${dim("Session:  ")} ${session.id}${session.title === "" ? "" : `  "${oneLine(session.title, 50)}"`}`);
  console.log(`${dim("Thinking: ")} ${thinkingLabel()}`);
  console.log(`${dim("Shell:    ")} ${shellName()}`);
  console.log(`${dim("Directory:")} ${cwd}`);
  console.log();
  console.log(dim(`WARNING: this agent runs ${shellName()} commands and can modify files.`));
  console.log(dim("Only run it in a directory/environment you trust."));
  console.log();

  const runTask = async (task: string): Promise<void> => {
    if (session.title === "") session.title = titleFor(task);
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
      // Saved even when the task failed, so no step is lost.
      busy = false;
      saveSession(session);
    }
    console.log();
    console.log(answer);
    console.log(
      dim(`(${((Date.now() - started) / 1000).toFixed(1)}s, ${session.messages.length} msgs)`),
    );
  };

  if (args.task != null) {
    await runTask(args.task);
    return;
  }

  console.log(dim(`Type a task, or /help. Saved as ${session.id}.\n`));
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
      session = newSession();
      agent = new Agent(ollama, cwd, session.messages);
      console.log(dim(`Started a new conversation: ${session.id}`));
      continue;
    }

    if (command === "sessions") {
      const saved = listSessions();
      if (saved.length === 0) {
        console.log(dim("No saved conversations yet."));
        continue;
      }
      printSessions(saved);
      const choice = Number(((await ask("Continue which? [0 = cancel]: ")) ?? "0").trim() || "0");
      if (Number.isInteger(choice) && choice >= 1 && choice <= saved.length) {
        const chosen = saved[choice - 1]!;
        const loaded = readSession(chosen.id);
        if (loaded !== null) {
          session = loaded;
          agent = new Agent(ollama, cwd, session.messages);
          console.log(dim(`Continuing "${oneLine(chosen.title, 60)}" (${session.messages.length} msgs).`));
        }
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
