# AnyAgent

A personal CLI agent that talks **straight to chat.deepseek.com over HTTPS** — no API key, no
browser, no tool schema. The model is simply someone in a chat who tells you what to type; the
agent types it, pastes the output back, and keeps going until the model stops asking for commands.

```
> what time is it?
  · Checking the clock.
  -> $ date
     ok

It is 14:32 UTC on Tuesday.
(3.1s)
```

Three source files, no runtime dependencies. `agent.ts` is the whole idea:

```
task -> model -> prose + maybe one ```sh block -> run it -> paste the output back -> ...
                                                              -> no block means it is the answer
```

---

## Requirements

- Node.js 20 or newer
- A chat.deepseek.com account, signed in **in a browser**

## Setup

The agent uses the session your browser already has, so copy it out once.

1. Open https://chat.deepseek.com and sign in.
2. Open DevTools → **Network**, and click any request to `/api/v0/...`
   (`create_pow_challenge` is a good one).
3. Under **Request Headers**, copy the values of `authorization` and `cookie`.
4. Save them in a file called `DEEPSEEK_SESSION_JSON` next to the project:

```json
{
  "authorization": "Bearer <the authorization value>",
  "cookie": "ds_session_id=<the cookie value>; ..."
}
```

Then:

```bash
npm install
npm start
```

The file is in `.gitignore`. When the session expires the backend says so, and you copy the two
headers again — that is the only maintenance this project needs.

## Usage

```bash
anyagent                  # pick one of your chats (or start one) and work in it
anyagent "task"           # run one task and exit
anyagent --new            # force a brand-new chat
anyagent --session ID     # continue a specific chat
anyagent --cwd DIR        # where the commands run (default: here)
```

In the chat: `/help`, `/sessions` (lists the chats on chat.deepseek.com and switches),
`/new`, `/exit`. Ctrl+C stops the command that is running; Ctrl+D or `/exit` quits.

**Everything lives on chat.deepseek.com.** The account's chats *are* the session list, and each
chat's messages *are* the history. Nothing is stored locally except your captured credentials, so
you can stop the agent and pick the same chat up later — even from another machine.

## How a reply becomes a command

The whole protocol is one line, said once at the start of a chat:

> I’m working in a shell. When a command is needed, give me only one command in a single `sh`
> block at a time; otherwise, don’t include a command block. I’ll run it and paste the output back
> to you.

So a reply is read like this:

- the **first fenced block that is a command** is run — one block per turn, in order;
- `sh`, `bash`, `cmd`, `powershell`, an untagged block, an unclosed block at the end, and tags
  like `{.sh}` or `cmd.exe` all count;
- a block tagged `json`, `text`, `python`, `diff`, … is a snippet, not a command. It stays in the
  reply as prose, and if the reply ends there the CLI notes that it was not run — a command is
  never dropped in silence;
- **no block at all means the task is finished** (or the model needs an answer from you), and the
  reply is printed as the final answer.

## How a command is run

`spawn(command, { shell: true })` — the platform's own shell does the work, so the same code runs
everywhere without guessing at shell paths: `cmd.exe` on Windows, `/bin/sh` elsewhere. Set
`ANYAGENT_SHELL` to a shell (a real `bash.exe`, for example) to use that instead.

stdout and stderr are collected in arrival order and sent back to the model with the exit code:

```
(no output)
Process exited with 0
```

A failing command is **not** an error. The output goes back like any other, so the model can read
what broke and try again.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `DEEPSEEK_SESSION_JSON` | — | the credentials inline instead of in the file |
| `DEEPSEEK_SESSION_PATH` | `./DEEPSEEK_SESSION_JSON` | where to read them from |
| `DEEPSEEK_MODEL_TYPE` | backend default | e.g. `deepseek-reasoner` |
| `DEEPSEEK_THINKING_ENABLED` | `1` | deep thinking. The reasoning is always discarded, never shown or run |
| `DEEPSEEK_SEARCH_ENABLED` | `0` | web search |
| `DEEPSEEK_MAX_ITERATIONS` | `50` | commands per task before it stops |
| `DEEPSEEK_SHELL_TIMEOUT_MS` | `120000` | per-command timeout |
| `ANYAGENT_SHELL` | platform shell | shell to run commands in |
| `ANYAGENT_HOST` | `https://chat.deepseek.com` | used by the tests |

## Windows

Works as-is on Windows 10 — the banner tells you which shell commands run in:

```
Shell:     cmd (C:\Windows\system32\cmd.exe)
```

Commands are handed to `cmd.exe`, so `dir`, `type` and `echo %time%` work natively. Install Git
for Windows and set `ANYAGENT_SHELL` to the `bash.exe` in `Git\bin` if you would rather have bash.

## Tests

```bash
npm test
```

Two suites, both real:

- **`test-agent.mjs`** — offline. Which reply text is a command, which stream text is the answer,
  the starter prompt, and the shell runner actually running (`exit 3` is reported as 3, stderr is
  never hidden).
- **`test-http.mjs`** — end to end. The real CLI, real HTTP, real proof-of-work module and a real
  command creating a real file, against a stand-in chat.deepseek.com on localhost. It checks that
  the answer is pasted back as the output plus the exit code, and that a command which appeared
  only in the model's *thinking* is **not** run.

## Notes

- **Proof of work is best effort.** The challenge is solved with the `sha3_wasm_bg.wasm` that
  ships here; if this build cannot solve one, the request is still sent and whatever the backend
  says about it is what you see — instead of a local "could not be solved" that explains nothing.
- **The model's thinking is never read.** A message arrives as typed fragments (thinking,
  answer), and only the fragments that declare themselves the answer are used. A command the model
  merely *considered* cannot be run.
- **A dropped connection is not a lost answer.** If a turn comes back empty, the chat is checked
  for the answer DeepSeek stored anyway before asking again.

## Other versions

| Version | What it is |
|---|---|
| `main` (v5.0.0) | this one — direct HTTPS, the `sh`-block protocol |
| `browser` (v4.0.1) | drives chat.deepseek.com in a real browser |
| `ollama` (v3.0.1) | the same agent against a local Ollama model |
| `deepseek-web` (v2.0.0) | browser transport, JSON `{"text","command"}` protocol |
| `direct-api` (v1.0.0) | the first direct version, JSON tool protocol |
