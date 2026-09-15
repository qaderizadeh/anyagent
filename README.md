# AnyAgent

A small command-line AI agent that drives **chat.deepseek.com** in a real
browser — no API key, no credentials file.

It runs shell commands on your machine and keeps **every conversation on
DeepSeek's side**. Nothing is stored locally.

Part of [anydev.ir](https://anydev.ir).

## Why a browser

AnyAgent used to call DeepSeek's API directly from Node. That works, but the
requests had a script's fingerprint and went out far faster than a person
could type — and the account was flagged for it.

So it now drives the site the way you would: it opens Chromium with a
persistent profile, types the prompt into the message box, presses Enter, and
reads DeepSeek's own `/chat/completion` response off the wire. Requests carry a
real browser, a real session and a human pace.

The direct-HTTP version is kept, unchanged and working, on branch **`direct-api`**
and tag **`v1.0.0`**:

```bash
git checkout direct-api
```

## How it works

```text
task -> DeepSeek -> {"text", "command"} -> run one command -> result -> DeepSeek -> ... -> text
```

That is the whole program. Three files:

| File | What it is |
|---|---|
| `src/browser.ts` | transport: the browser window, the composer, the session list, reading the reply |
| `src/agent.ts` | the loop, one shell command, one reply shape |
| `src/cli.ts` | banner, session picker, REPL |

### No local state

The chat that is open in the browser window is the conversation. Sessions and
messages live on chat.deepseek.com, so you can close the terminal, run AnyAgent
on another machine, or edit the conversation on the website — it is the same
conversation.

The one thing on disk is the browser profile (`~/.anyagent/browser` by
default), which holds your login. Nothing else is written.

## Requirements

- Node.js 20+
- Chromium, installed once: `npx playwright install chromium`
- A shell. Linux and macOS already have `bash`. On Windows AnyAgent uses a Git
  Bash if one is on your `PATH` and `cmd.exe` otherwise. Set `ANYAGENT_SHELL`
  to a path or a name to pick a different one.

## Setup

```bash
npm install
npx playwright install chromium     # once, downloads the browser
npm start
```

On the first run a Chromium window opens at chat.deepseek.com. **Sign in there
once** — AnyAgent waits and then carries on by itself. The profile keeps the
login, so later runs go straight to the prompt.

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
  · Writing the file now.
  -> shell: printf 'Hello World' > hello.txt
     ok
Done. Created hello.txt with "Hello World".
(4.1s)
```

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `ANYAGENT_PROFILE_DIR` | `~/.anyagent/browser` | browser profile — this holds the login |
| `ANYAGENT_HEADLESS` | `0` | `1` hides the window (see the note below) |
| `ANYAGENT_BROWSER_PATH` | Playwright's Chromium | use your own Chrome or Edge binary |
| `ANYAGENT_PACE_MS` | `800` | pause before each prompt, so turns are not fired back to back |
| `ANYAGENT_LOGIN_TIMEOUT_MS` | `300000` | how long to wait for you to sign in |
| `ANYAGENT_COMPLETION_TIMEOUT_MS` | `300000` | how long one turn may take |
| `ANYAGENT_SHELL` | `bash`, or `cmd.exe` on Windows | shell commands run in |
| `DEEPSEEK_THINKING_ENABLED` | `1` | deep thinking |
| `DEEPSEEK_SEARCH_ENABLED` | `0` | web search |
| `DEEPSEEK_MAX_ITERATIONS` | `50` | loop limit per task |
| `DEEPSEEK_SHELL_TIMEOUT_MS` | `120000` | per-command timeout |

## The reply

The agent has exactly one answer shape. Every model turn is one JSON object
with a note for you and one command:

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
on, the message says which of the two things happened: **nothing came back**
(the turn is retried after a short delay) or a **wrong shape** (the offending
reply is printed).

### Losing a reply

The stream is the longest-lived part of a turn, so it is the first thing a
flaky connection breaks. DeepSeek carries on and stores the finished answer
anyway, so an empty turn is looked up in the chat's history before anything
else happens — a hiccup does not throw the model's work away. A turn that was
never stored at all is detected within a few seconds and retried.

## Notes

- **Thinking and search** are per-message switches in the composer. AnyAgent
  sets them on the completion request itself rather than clicking a button
  whose markup it would have to guess at, so `DEEPSEEK_THINKING_ENABLED` and
  `DEEPSEEK_SEARCH_ENABLED` still apply to every turn.
- **Typing is real.** The prompt is entered into the composer and sent, so the
  request is the one the site itself makes: its headers, its proof of work, its
  browser fingerprint.
- **Reads** (the session list, a chat's history) go through the page's own
  `fetch`, so they carry the browser's session too. Only the reply is read off
  the wire.
- **Headless** works if the profile is already signed in
  (`ANYAGENT_HEADLESS=1`), but the whole point is to look like a normal
  browser, so the window is visible by default.
- **One window at a time.** The profile is locked while AnyAgent runs, so
  don't start a second copy against the same profile.
- `dist/` is build output and is not tracked, but `npm start` compiles first,
  so `git pull && npm start` is always up to date.

## Security

This agent runs **real shell commands** with your user's permissions, and its
working directory is wherever you point `--cwd`. There is no sandbox.

- Only run it in a directory/environment you trust.
- It never listens on a network port and exposes no service.
- The browser profile is equivalent to your DeepSeek login. Keep it private.
- Commands run one at a time, so you can interrupt with Ctrl+C.

## License

MIT
