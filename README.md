# AnyAgent

A small CLI agent that drives **chat.deepseek.com** in a real browser.

It has a normal conversation. The model writes a command, AnyAgent runs it, and
the output gets typed back — the same thing you would do by hand. There is no
API key, no tool schema, and no "agent framework".

```
> create a file called hello.txt containing Hello World

  · Let me write that file.
  -> $ printf 'Hello World' > hello.txt && wc -c < hello.txt
     ok

Created hello.txt with Hello World.
(4.1s)
```

## Why a normal chat

Earlier versions told the model it was "an agent with a shell tool" and made it
answer with a strict JSON object every turn. That works, but it is a machine
talking to a machine: a fixed schema, a fixed shape, every single message.

This version is a person talking to DeepSeek. The model replies however it
likes; when there is a command in it, AnyAgent runs that command and pastes the
output back. A reply with no command means the task is over — finished, or
blocked and asking for something only a person can do.

```
task ─→ reply ─→ fenced command? ──no──→ done
                       │yes
                       ↓
                  run it, paste the output back
```

The only structure asked for is a fenced block for the command. Everything else
— the prose, the questions, the shape of the answer — is left to the model.

## What is sent, and what comes back

Everything lives on chat.deepseek.com. The CLI opens a chat, keeps it open, and
nothing is stored on your machine except the browser profile.

```
You:  I'm at a bash prompt on my Linux machine, in /home/me/app, and I'll paste
      back whatever prints. Give me one command at a time in a ```bash block...

      create a file called hello.txt containing Hello World

It:   Let me write that file.
      ```bash
      printf 'Hello World' > hello.txt && wc -c < hello.txt
      ```

You:  11

It:   Created `hello.txt` with Hello World.
```

Three things worth knowing about what gets sent:

- **The setup is said once**, as the first message of a new chat. A person does
  not re-introduce themselves before every question.
- **The output is the only thing typed back.** No `$` echo, no exit code for a
  success. A failure says so (`(exit code 2)`), because a person would mention
  it. Very long output is marked where it was cut.
- **One command at a time.** Each block runs in a fresh shell in the working
  directory, so `cd` does not carry over — the model is told that, and chains
  with `&&` when it matters.

## On Windows

Commands run in the shell the setup names, and AnyAgent picks one that can
actually do the job:

1. `ANYAGENT_SHELL`, if you set it.
2. A **real** bash — Git Bash, MSYS2 or Cygwin, looked for in their usual
   install locations and on `PATH`.
3. Otherwise `cmd.exe`.

`C:\Windows\System32\bash.exe` is deliberately **never** used. That file is not
a shell, it is the WSL launcher: a command sent to it either fails or runs
inside a Linux box that cannot see the Windows working directory. Both look like
the agent never runs anything at all.

Windows-flavoured fences count as commands. The model may answer with `cmd`,
`bat` or `powershell` even when the setup said bash; those run in the shell they
name rather than being passed over as prose — a block that gets ignored is
indistinguishable from a command that was never executed.

The tag is read however it is written — `CMD`, `cmd.exe`, `{.cmd}`,
`cmd-script`, `cmd (Windows)`, `windows powershell` all land on the right shell.
And a block that is *not* a command is never passed over silently: if the reply
that ends the task still holds one, the CLI names it:

```
  · Here is the config.
  ! the ```json block was not run (not a command)
```

A `C:\Users\me>` or `PS C:\Users\me>` prompt that the model copies into a block
is stripped, and `\r\n` line endings are tolerated, so the command that reaches
the shell is the command that was written. The banner prints which shell was
chosen, path and all, so the choice is never a guess:

```
Shell:     bash (C:\Program Files\Git\bin\bash.exe)
```

## How it reaches DeepSeek

Not over the API. AnyAgent opens a real Chromium, pastes the prompt into the
real composer, presses Enter, and reads DeepSeek's own response off the wire.
The request is the one the site makes itself, with its own fingerprint, its own
proof of work and a human pace — not a script's.

The window is **hidden** by default, and the sign-in is the `authorization` and
`cookie` you already capture from your browser, put in before the page's
scripts run. Nothing is typed; the prompt is pasted in one go.

## Install

```bash
npm install
```

Then either:

- **use the session you captured** — put it next to the project as
  `DEEPSEEK_SESSION_JSON` (see below), or
- **sign in once in a window** — `ANYAGENT_HEADLESS=0 npm start`, sign in, and
  the browser profile remembers it. Later runs can be hidden again.

`npx playwright install chromium` is only needed if the machine has no Chrome,
Edge or Chromium already — AnyAgent uses the one you have.

## The session file

In the project folder, next to `package.json`:

1. Open <https://chat.deepseek.com> and sign in.
2. DevTools → **Network**. Click any request to `/api/v0/…`
   (`create_pow_challenge` is a good one).
3. Under **Request Headers**, copy `authorization` and `cookie`.
4. Write them into `DEEPSEEK_SESSION_JSON`:

```json
{
  "authorization": "Bearer eyJhbGciOi...",
  "cookie": "ds_session_id=abc123...; smidV2=...; aws-waf-token=..."
}
```

`token` + `cookies` (a name→value map) works too. If the capture is rejected,
AnyAgent says so up front and tells you to re-capture — the `aws-waf-token`
cookie is usually the first to expire.

## Use

```bash
npm start                              # chat in the current directory
npm start -- "list the largest files"  # one task and exit
npm start -- --cwd ~/project           # run somewhere else
npm start -- --new                     # start a fresh DeepSeek chat
npm start -- --session <id>            # continue a specific chat
```

At startup you pick from the sessions already on your account, and `/sessions`
switches between them mid-run. `npm start` compiles first, so there is no
separate build step and no stale `dist/`.

| Command | |
|---|---|
| `/help` | show the commands |
| `/sessions` | list your DeepSeek chats and switch |
| `/new` | start a new chat |
| `/exit` | quit (also Ctrl+C, Ctrl+D) |

While a task is running, Ctrl+C stops the command that is running and keeps the
session alive, so the model sees what failed and can try something else.

## Settings

| Variable | Default | |
|---|---|---|
| `DEEPSEEK_SESSION_JSON` | — | the captured session inline, or `DEEPSEEK_SESSION_PATH` for a file |
| `ANYAGENT_HEADLESS` | `1` | `0` shows the browser window |
| `ANYAGENT_BROWSER_PATH` | — | use a specific browser instead of the one found |
| `ANYAGENT_PROFILE_DIR` | `~/.anyagent/browser` | where the browser profile lives |
| `ANYAGENT_PACE_MS` | `300` | pause before each prompt |
| `ANYAGENT_SHELL` | a real bash, else `cmd.exe` on Windows | shell the commands run in (must take `-c`, or be `cmd.exe`) |
| `DEEPSEEK_THINKING_ENABLED` | on | deep thinking, per message |
| `DEEPSEEK_SEARCH_ENABLED` | off | web search, per message |
| `DEEPSEEK_MAX_ITERATIONS` | `50` | loop limit |
| `DEEPSEEK_SHELL_TIMEOUT_MS` | `120000` | command timeout |

## Tests

```bash
npm test
```

`test-agent.mjs` covers the protocol with no browser: which blocks count as a
command, what gets pasted back, when a task ends, and the loop's failure paths.

`test-live.mjs` drives the real `dist/cli.js` through a real Chromium against a
stand-in chat.deepseek.com — HTTPS on localhost, mapped to the real hostname at
the browser level, so the production transport runs unmodified. It checks the
command actually runs, the output is what gets typed back, the setup is not
repeated in a resumed chat, and a failing command reaches the model.

## WARNING

This runs shell commands and modifies files. Only run it in a directory and
environment you trust. It is not sandboxed.

---

Other backends, kept on their own branches and tags:

| | |
|---|---|
| `direct-api` · `v1.0.0` | calls the DeepSeek HTTP API directly with a key |
| `deepseek-web` · `v2.0.0` | browser-driven, strict `{"text","command"}` protocol |
| `ollama` · `v3.0.1` | local Ollama models, zero runtime dependencies |
