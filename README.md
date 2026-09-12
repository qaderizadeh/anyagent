# AnyAgent — your personal CLI AI agent (anydev.ir)

The smallest practical CLI AI agent that talks **directly to chat.deepseek.com** —
no API key, no browser automation, no proxy service, no port. Made for personal
use, by [anydev.ir](https://anydev.ir).

The agent is a simple loop:

```
User task
    ↓
DeepSeek
    ↓
Final response? ── yes ──→ print response and exit
    │
    no
    ↓
Tool call → execute → result → back to DeepSeek → repeat
```

One-time setup is just a pasted web session (see below). After that the agent runs
fully autonomously until it finishes or you interrupt it. No frameworks, no
abstractions — the whole loop is readable in `src/agent.ts`.

## How it works

- The agent speaks the real DeepSeek web chat protocol:
  `POST /api/v0/chat_session/create`, `POST /api/v0/chat/create_pow_challenge`,
  and `POST /api/v0/chat/completion` (SSE), all against `https://chat.deepseek.com`.
- Authentication is the session token + cookies from your signed-in browser,
  pasted into a small JSON file. No API key is needed.
- The proof-of-work challenge is solved locally with the `sha3_wasm_bg.wasm`
  binary that the DeepSeek site itself loads (see "Refreshing the PoW binary").

## Requirements

- Node.js 20+
- A DeepSeek web account

## Setup

```bash
npm install
npm run build
```

Then capture a session once:

1. Open https://chat.deepseek.com in your browser and sign in.
2. Open the browser developer console (F12) on that page.
3. Grab your session token and cookies. For example:
   ```js
   // token is usually under localStorage:
   localStorage.getItem("userToken");
   // cookies for the chat.deepseek.com domain:
   document.cookie;
   ```
4. Paste them into `DEEPSEEK_SESSION_JSON` (the file in this repo) — see the
   placeholder for the exact shape. Keep it out of version control.

On startup the CLI checks that file (or `DEEPSEEK_SESSION_PATH` /
`DEEPSEEK_SESSION_JSON` env), verifies the session by touching the backend, and:

- if it works → straight to the prompt;
- if it is missing/expired/rejected → clear instructions and exit.

Sessions expire; when the CLI says so, repeat the capture and rerun.

## Usage

```bash
# interactive session (asks which saved session to continue, if any)
anyagent

# single task
anyagent "create a hello world TypeScript project"

# continue the most recent session
anyagent --resume

# continue a specific session
anyagent --session 20260908-143502

# work in another directory
anyagent --cwd ./project "list the files here"
```

Example session:

```text
AnyAgent
────────────────────────────
Backend:   chat.deepseek.com (direct, no API key)
Model:     default (chat.deepseek.com)
Thinking:  enabled
Search:    disabled
Directory: /home/me/demo

WARNING: this agent executes shell commands and can modify files.
Only run it in a directory/environment you trust.

> create a file called hello.txt containing "Hello World"
  → shell: printf 'Hello World\n' > hello.txt
  ✓ shell

Done. Created hello.txt.
```

Every conversation is saved under `~/.anyagent/sessions/` after each turn, so you
can quit and resume later with `--resume` or the startup picker. Commands:

```
/help      show help
/sessions  list saved sessions and switch to one
/new       start a brand-new session
/clear     forget the current conversation
/exit      quit (also: Ctrl+C, Ctrl+D)
```

While a task is running, **Ctrl+C stops the current shell command** (the model is
told it was interrupted and can try something else) and the session stays alive.
Press Ctrl+C again at the prompt, or type `/exit`, to quit.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `DEEPSEEK_SESSION_PATH` | *(none)* | Path to a pasted session JSON file |
| `DEEPSEEK_SESSION_JSON` | *(none)* | Pasted session JSON, inline |
| `DEEPSEEK_POW_WASM_PATH` | `./sha3_wasm_bg.wasm` | Path to the PoW wasm binary |
| `DEEPSEEK_BASE_URL` | `https://chat.deepseek.com` | Backend override (proxies/tests) |
| `DEEPSEEK_MODEL_TYPE` | *(backend default)* | e.g. `deepseek-reasoner` |
| `DEEPSEEK_THINKING_ENABLED` | `1` | Enable deep thinking (slower, more careful) |
| `DEEPSEEK_SEARCH_ENABLED` | `0` | Let the model browse the web itself (off by default) |
| `DEEPSEEK_MAX_ITERATIONS` | `50` | Safety cap on agent loop iterations |
| `DEEPSEEK_SHELL_TIMEOUT_MS` | `120000` | Shell tool timeout |
| `ANYAGENT_SESSIONS_DIR` | `~/.anyagent/sessions` | Where conversation history is stored |

## Tools

The agent ships with exactly **one** tool: `shell` — run any command in the working
directory; returns `{exitCode, stdout, stderr}`. It works on any OS: Node picks
`sh`/`bash` on POSIX and `cmd` on Windows. Everything the agent needs to do —
inspect the system, create and edit files, install and run programs, verify
results — goes through shell commands, so the tool surface stays minimal.

Commands are non-interactive: stdin is empty, so anything that would prompt
(an `ssh` passphrase, a pager, `npm login`) gets EOF instead of hanging until the
timeout.

Long-running commands (servers, watchers) are killed after the shell timeout; the
whole descendant tree is killed (Linux/macOS: `/proc` + `pgrep` walk, Windows:
`taskkill /T /F`) so the agent can never wedge on a leaked process. A killed
command comes back marked, e.g.
`{"exitCode": -1, "timedOut": true, "stderr": "..."}` or `"interrupted": true`
for Ctrl+C, and the CLI shows those as `✗` rather than a misleading `✓`.
Tool failures never crash the agent — they are returned to the model as
`{"error": true, "message": ...}` so DeepSeek can react and try another approach.

## Refreshing the PoW binary

chat.deepseek.com gates chat requests behind a proof-of-work challenge solved by a
WASM binary (`sha3_wasm_bg.wasm`) served from the site. This project solves it
locally in Node — no browser is needed at runtime after the session is captured.

DeepSeek can change that binary without notice. If you see a
"Proof-of-work could not be produced" error, refresh the binary:

1. In your browser, find the JS that loads the PoW worker (search for
   `sha3_wasm_bg` in DevTools → Network/Sources on chat.deepseek.com).
2. Download the `.wasm` file it references.
3. Replace `sha3_wasm_bg.wasm` in this repo (or set `DEEPSEEK_POW_WASM_PATH`).

## Project layout

```text
src/
├── agent.ts    # the agent loop (system prompt, tool dispatch, iteration cap)
├── deepseek.ts # direct chat.deepseek.com client: session, PoW, SSE, resume
├── model.ts    # thin chat wrapper the agent uses (session-aware)
├── tools.ts    # the shell tool + generic registry
├── sessions.ts # conversation history: save/list/load under ~/.anyagent/sessions
└── cli.ts      # interactive / single-task CLI + session picker + commands
```

## Security

This is a local coding agent with shell access and file write permission. It can run
arbitrary commands and modify files in its working directory. Only run it in a
directory/environment you trust. It binds to nothing and exposes no network service.

## Notes

- The agent never runs forever: after `DEEPSEEK_MAX_ITERATIONS` model round-trips it
  stops and reports `Agent stopped: maximum iterations reached.`
- `chat.deepseek.com` may change its protocol at any time. If the client breaks,
  the fields it uses are all in `src/deepseek.ts`, easy to update in one place.