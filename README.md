# AnyAgent

A small command-line AI agent that thinks with **a model on your own machine**
through [Ollama](https://ollama.com), runs shell commands for you, and keeps
every conversation as a plain JSON file on your disk.

No API key. No account. No cloud. Nothing leaves your computer.

Part of [anydev.ir](https://anydev.ir).

## Where this came from

AnyAgent has been through three backends, and the two old ones are still here:

| Version | Backend | Kept at |
|---|---|---|
| **v3.0.0** | **Ollama on your machine** | `main` — this one |
| v2.0.0 | chat.deepseek.com driven in a real browser | tag `v2.0.0`, branch `deepseek-web` |
| v1.0.0 | DeepSeek's HTTP API from Node | tag `v1.0.0`, branch `direct-api` |

The DeepSeek versions worked, and then the account was restricted. Running the
model locally removes that whole class of problem — no session to capture, no
rate limit to trip, no terms of service to argue with. It also happens to be
simpler: the v2 browser backend was 1,047 lines; this is about 700, with **zero
runtime dependencies**.

```bash
git checkout direct-api     # the original, if you ever want it
```

## How it works

```text
task -> model -> {"text", "command"} -> run one command -> result -> model -> ... -> text
```

That is the whole program. Four small files:

| File | What it is |
|---|---|
| `src/ollama.ts` | transport: list the models, ask one of them, explain failures |
| `src/agent.ts` | the loop, one shell command, one reply shape |
| `src/sessions.ts` | conversations on disk |
| `src/cli.ts` | banner, conversation picker, REPL |

### The reply is a schema, not a hope

Every request tells Ollama the exact shape it will accept, as a JSON schema.
Ollama turns that into a grammar, so the model **cannot** answer with prose, a
code fence, or a "Sure, here you go" — however small the model is. That is why
this project has no parsing heuristics and no retry storm.

## Requirements

- Node.js 20+
- [Ollama](https://ollama.com/download), running, with at least one model:
  ```bash
  ollama serve
  ollama pull llama3.2
  ```

Any model works. Bigger models make fewer mistakes; models with tool-calling or
thinking training get more out of it. Small ones are fine — the reply shape is
guaranteed by the schema, not by the model's manners.

## Setup

```bash
npm install
npm start
```

`npm install` pulls dev dependencies only TypeScript needs. There is nothing to
download at runtime, no browser, no wasm.

## Usage

```bash
anyagent                     # pick a conversation (or start one) and chat
anyagent "list the largest files here"
anyagent --new               # force a brand-new conversation
anyagent --session ID        # continue a saved conversation
anyagent --model qwen2.5:7b  # use a specific model
anyagent --cwd ~/project     # run commands in another directory
```

In the REPL:

```text
/help       show commands
/sessions   list saved conversations and switch to one
/new        start a new conversation
/exit       quit (also Ctrl+C, Ctrl+D)
```

Example:

```text
> create a file called hello.txt containing "Hello World"
  · Writing it now.
  -> shell: printf 'Hello World' > hello.txt
     ok
Done. Created hello.txt with "Hello World".
(6.2s, 4 msgs)
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `OLLAMA_URL` | `http://127.0.0.1:11434` | where Ollama listens |
| `OLLAMA_MODEL` | — | model to use (otherwise: the only one installed, or a choice) |
| `OLLAMA_TIMEOUT_MS` | `300000` | how long one reply may take |
| `ANYAGENT_THINKING` | the model's own | `1`/`0` to force thinking on or off |
| `ANYAGENT_SHELL` | `bash`, or `cmd.exe` on Windows | shell commands run in |
| `ANYAGENT_MAX_ITERATIONS` | `50` | steps allowed per task |
| `ANYAGENT_SHELL_TIMEOUT_MS` | `120000` | per-command timeout |
| `ANYAGENT_CONTEXT_MESSAGES` | `24` | how much history travels with each request |
| `ANYAGENT_SESSIONS_DIR` | `~/.anyagent/sessions` | where conversations are saved |

`ANYAGENT_THINKING` is left unset on purpose. Ollama's `think` flag only works
on models built for it, so the model's own default is the right answer unless
you ask for something else. Setting it on a model that cannot think gives you a
message that says exactly that, rather than a cryptic 400.

## Conversations

Ollama keeps no state at all — every request carries the whole conversation —
so the conversation lives in `~/.anyagent/sessions/<id>.json`, one small file
per conversation, saved after every task. That is the only thing on disk.

That buys you something the DeepSeek versions could not do: your conversations
are yours, readable, and work offline. Copy a file to another machine and the
conversation goes with it. Delete a file and the conversation is gone.

```json
{"id":"20260918-153012","title":"create a file called hello.txt","updatedAt":1787000000000,
 "messages":[{"role":"user","content":"create a file called hello.txt"}, ...]}
```

## The reply

The agent has exactly one answer shape. Every model turn is one JSON object with
a note for you and one command:

```json
{"text": "listing the directory", "command": "ls -la"}
```

One command per turn. The result goes back as
`{"exitCode":0,"stdout":"...","stderr":"..."}`; a failing command does not stop
the agent — the error goes back to the model, which decides what to do.

`text` is printed for **every** step, so nothing the model says is hidden:

```text
  · Checking the Node.js version first.
  -> shell: node --version
     ok
```

An **empty or missing `command` means the turn is over**: the task is done, or
the agent is blocked and needs you. Either way `text` is shown and the agent
stops.

## Notes

- **Long conversations get trimmed, not broken.** Local models have small
  contexts, so each request carries the system prompt and the last
  `ANYAGENT_CONTEXT_MESSAGES` messages. A 40-step task will not fail because the
  model cannot read 40 steps at once.
- **Command output is clipped** at 8,000 characters, with a note saying how much
  was cut. A local model cannot usefully read more than that in one go.
- **The shell is the platform's own.** `bash` on Linux and macOS, a Git Bash if
  one is on your Windows `PATH` and `cmd.exe` otherwise. The system prompt names
  the OS and the shell, so the model writes commands that actually run.
- **A command that never starts says why.** If the shell itself is missing you
  get `spawn /bin/bash ENOENT` in the step output instead of a bare `exit 1`.
- **Downloads once, then works offline.** Ollama keeps the model in memory for
  five minutes after each request by default, so a conversation stays quick.
- `dist/` is build output and is not tracked, but `npm start` compiles first, so
  `git pull && npm start` is always up to date.

## Security

This agent runs **real shell commands** with your user's permissions, and its
working directory is wherever you point `--cwd`. There is no sandbox.

- Only run it in a directory/environment you trust.
- It never listens on a network port and exposes no service.
- Nothing is sent anywhere except to your own Ollama at `OLLAMA_URL`.
- Commands run one at a time, so you can interrupt with Ctrl+C.

## License

MIT
