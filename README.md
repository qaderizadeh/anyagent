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
- Authentication is two request headers (`authorization` and `cookie`) copied
  from your signed-in browser into a small JSON file. No API key is needed.
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
2. Open DevTools → **Network** and click any request to `/api/v0/...`
   (`create_pow_challenge` is a good pick).
3. Under **Request Headers**, copy the values of `authorization` and `cookie`
   and paste them into `DEEPSEEK_SESSION_JSON` (the file in this repo):
   ```json
   {
     "authorization": "Bearer <the authorization header value>",
     "cookie": "<the cookie header value>",
     "user_agent": "Mozilla/5.0 ...",
     "captured_at": "2026-09-12T08:44:15.868Z"
   }
   ```
   `user_agent` and `captured_at` are optional. Keep the file out of version
   control.

Behind the scenes the loader accepts a few shapes, so older or scripted
captures keep working: `authorization` (or `token`) may be the bare token, the
`{"value":"...","__version":"0"}` localStorage wrapper, or a full
`Bearer ...` header value; `cookie` (or `cookies`) may be the raw header string
or a name→value map. Everything is normalized before use.

On startup the CLI checks that file (or `DEEPSEEK_SESSION_PATH` /
`DEEPSEEK_SESSION_JSON` env), verifies the session by touching the backend, and:

- if it works → straight to the prompt;
- if it is missing/invalid/rejected → clear instructions and exit.

DeepSeek's web token lives much longer than a working day, so a session captured
days or weeks ago usually still works. The file's `captured_at` is only used for
a **non-fatal** heads-up: after 30 days the CLI prints a one-line note and
continues — the backend is the real authority, and its verification request is
what decides. Override the window with `DEEPSEEK_SESSION_MAX_AGE_MS` if you want
a different one.

Sessions do eventually expire; when the CLI says the backend rejected the
session, repeat the capture and rerun.

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
can quit and resume later with `--resume` or the startup picker.

The DeepSeek side of a conversation lives on `chat.deepseek.com`, not in the
session file: each saved session remembers which DeepSeek chat it belongs to and
continues that same chat. If that chat can no longer be continued (an old session
file, a chat deleted on the web side, an expired link), AnyAgent does **not**
start a blank chat: it replays the tool rules and a compact recap of the earlier
turns into a new DeepSeek session and tells you it did so — once, not on every
step. You keep your context instead of getting a context-free reply.

The linkage can also go stale on the DeepSeek side, and that is recovered
transparently too:

- `biz_code 26: invalid message id` — the message a resumed turn points at no
  longer exists (it usually came from a reply that never finished). The agent
  continues in the **same** chat with no parent message and the header + history
  replayed, and says so once.
- `biz_code 1: invalid chat session id` — the chat itself is gone, so a fresh one
  is created and re-seeded, exactly like the case above.

Either way the conversation keeps working; a stale pointer can no longer make
every future turn fail. The recovery is attempted **once** — if DeepSeek still
refuses, the real error is shown instead of retrying forever.

If DeepSeek returns an application-level error instead of a normal reply (for
example `biz_code 5: user is muted` after too many requests in a burst), the agent
reports it plainly and stops instead of looping. A mute is a DeepSeek-side limit
on automated use: wait for it to expire, then retry — nothing needs re-capturing.

Tool calls are read from either format a reply might use — the documented
`{"tool_calls":[...]}` JSON, or the XML markup
(`<tool_calls><invoke name="shell"><parameter name="command">…`) that replies
occasionally fall back to. If a call still cannot be read it is **never** printed
at you as an answer; the agent asks the model to re-send it as JSON, a few times,
then stops with a clear message.

Transient failures are distinguished from real ones. A dropped connection, DNS
failure, or `HTTP 429/5xx` is retried twice with a short backoff, and if it keeps
failing you get the actual reason (`Cannot reach chat.deepseek.com …:
ECONNREFUSED`) instead of a bare `fetch failed`. Deterministic failures — a mute,
an invalid session, a malformed reply — are **not** retried, since repeating them
only burns quota and hides the cause.

Commands:

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
| `DEEPSEEK_SESSION_MAX_AGE_MS` | 30 days | Advisory freshness window for the session file |
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