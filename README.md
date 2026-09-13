# AnyAgent

A small command-line AI agent that talks directly to **chat.deepseek.com**
using your own browser session — no API key, no browser automation.

It runs bash commands on your machine and keeps **every conversation on
DeepSeek's side**. Nothing is stored locally.

Part of [anydev.ir](https://anydev.ir).

## How it works

```text
task -> DeepSeek -> {"text", "command"} -> run bash -> result -> DeepSeek -> ... -> text
```

That is the whole program. Three files:

| File | What it is |
|---|---|
| `src/deepseek.ts` | transport: credentials, proof-of-work, the six backend endpoints |
| `src/agent.ts` | the loop, one bash command, one reply shape |
| `src/cli.ts` | banner, session picker, REPL |

### No local state

Sessions and messages live on chat.deepseek.com. On start AnyAgent asks the
backend for your chat list, you pick one (or start a new one), and each turn
is appended to that chat there. You can close the terminal, run AnyAgent on
another machine, or edit the conversation in the web UI — it is the same
conversation.

The only local file is your captured credentials, `DEEPSEEK_SESSION_JSON`,
which is git-ignored.

## Requirements

- Node.js 20+
- `bash` (Linux, macOS, WSL, Git Bash)

## Setup

```bash
npm install
npm run build
```

### Capture your DeepSeek session

1. Open <https://chat.deepseek.com> and sign in.
2. Open DevTools → **Network**, and click any request to `/api/v0/...`
   (`create_pow_challenge` is a good pick).
3. Under **Request Headers**, copy the values of `authorization` and `cookie`.
4. Save them next to the project as `DEEPSEEK_SESSION_JSON`:

```json
{
  "authorization": "Bearer <token>",
  "cookie": "ds_session_id=<...>; ..."
}
```

That is all the agent needs. (`token` is accepted as an alias for
`authorization`, and `cookies` for `cookie`; a cookie name→value map works too.)

> Re-capture when DeepSeek signs you out. The `aws-waf-token` cookie inside
> `cookie` is the one that usually expires first.

## Usage

```bash
anyagent                     # pick a session (or start one) and chat
anyagent "list the largest files here"
anyagent --new               # force a brand-new session
anyagent --session <id>      # continue a specific session
anyagent --cwd ~/project     # run commands in another directory
```

In the REPL:

```text
/help       show commands
/sessions   list DeepSeek sessions and switch to one
/new        start a new DeepSeek session
/exit       quit (also Ctrl+C, Ctrl+D)
```

Example:

```text
> create a file called hello.txt containing "Hello World"
  -> shell: printf 'Hello World' > hello.txt
     ok
Done. Created hello.txt with "Hello World".
(3.2s)
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `DEEPSEEK_SESSION_JSON` | — | credentials as inline JSON |
| `DEEPSEEK_SESSION_PATH` | — | path to a credentials file |
| `DEEPSEEK_MODEL_TYPE` | backend default | e.g. `deepseek-reasoner` |
| `DEEPSEEK_THINKING_ENABLED` | `1` | deep thinking |
| `DEEPSEEK_SEARCH_ENABLED` | `0` | web search |
| `DEEPSEEK_MAX_ITERATIONS` | `50` | loop limit per task |
| `DEEPSEEK_SHELL_TIMEOUT_MS` | `120000` | per-command timeout |
| `DEEPSEEK_POW_WASM_PATH` | `./sha3_wasm_bg.wasm` | proof-of-work binary |

## The reply

The agent has exactly one answer shape. Every model turn is one JSON object
with a note for you and one bash command:

```json
{"text": "listing the directory", "command": "ls -la"}
```

One command per turn. The result goes back as
`{"exitCode":0,"stdout":"...","stderr":"..."}`; a failing command does not
stop the agent — the error goes back to the model, which decides what to do.

`text` is printed for **every** step, so nothing the model says is hidden:

```text
  · Checking the Node.js version first.
  -> shell: node --version
     ok
```

An **empty or missing `command` means the turn is over**: the task is done, or
the agent is blocked and needs you. Either way `text` is shown to you and the
agent stops.

If a reply is not this shape, the model is asked again. When it still cannot go
on, the message says which of the two things happened, instead of a generic
failure: an **empty reply** (the backend sent nothing at all, so the same
prompt is retried after a short delay) or a **wrong shape** (the offending
reply is printed).

A dropped connection can end the stream before anything arrives, while DeepSeek
carries on and stores the finished answer anyway. An empty turn is therefore
looked up on chat.deepseek.com first and used if it is there, so a hiccup does
not throw the model's work away.

## Security

This agent runs **real bash commands** with your user's permissions, and its
working directory is wherever you point `--cwd`. There is no sandbox.

- Only run it in a directory/environment you trust.
- It never listens on a network port and exposes no service.
- Your DeepSeek session is equivalent to your login — keep the credentials
  file out of version control (it is already in `.gitignore`).
- Commands run one at a time, so you can interrupt with Ctrl+C.

## Notes

- **Proof of work.** chat.deepseek.com requires a solved challenge on
  `/api/v0/chat/completion` and `/api/v0/chat/create_pow_challenge`. The
  vendored `sha3_wasm_bg.wasm` does the solving; if DeepSeek changes it,
  replace the binary and `src/global.d.ts` is where its interface is described.
- **Session listing** is `GET /api/v0/chat_session/fetch_page`. The backend
  rejects `count` below 2, so the parameter is omitted for smaller values.
- **Recovery.** If the message id the agent replies to no longer exists, it
  retries once without a parent; if the chat session itself was deleted on the
  web side, it starts a fresh one and tells you.
- **Dropped connections.** When a turn comes back empty the agent does not
  immediately ask again: it waits for the answer to show up in the chat's
  history and uses that, since the backend finishes and stores it regardless.
  A turn that was never stored is detected in a few seconds and retried.
- `dist/` is build output and is not tracked, so run `npm run build` after
  every `git pull`.

## License

MIT
