/**
 * End-to-end: the real CLI, a real Chromium, and a stand-in chat.deepseek.com.
 *
 * The fake site is served over TLS on localhost and mapped to the real
 * hostname at the browser level (--host-resolver-rules), so the production
 * Browser class runs unmodified - same launch, same seeding, same typing,
 * same response parsing.
 *
 * It only answers the API calls the transport makes, and it records what it
 * was sent, so the prompt on the wire can be checked too.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { chromium } from "playwright";

const ROOT = process.cwd();
const PORT = 8443;
const HOST = `chat.deepseek.com`;
const CHAT_ID = "11111111-2222-3333-4444-555555555555";

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${String(error.message).split("\n")[0]}`);
  }
}

/* ------------------------------------------------------------------ */
/* a certificate for the real hostname                                 */
/* ------------------------------------------------------------------ */

const work = fs.mkdtempSync(path.join(os.tmpdir(), "anyagent-e2e-"));
const key = path.join(work, "key.pem");
const cert = path.join(work, "cert.pem");

/** A throwaway certificate for chat.deepseek.com, so the fake site can be HTTPS. */
function makeCert() {
  const result = spawnSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", key, "-out", cert, "-days", "2",
      "-subj", `/CN=${HOST}`,
      "-addext", `subjectAltName=DNS:${HOST}`,
    ],
    { stdio: "ignore" },
  );
  return result.status === 0 && fs.existsSync(key) && fs.existsSync(cert);
}

if (!makeCert()) {
  console.log("\nSkipped: openssl is needed to serve the stand-in site over HTTPS.\n");
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* the stand-in site                                                   */
/* ------------------------------------------------------------------ */

/** What the fake DeepSeek answers, one entry per turn. */
let replies = [];
/** Every prompt the site was sent, in order. */
const prompts = [];
/** Every completion request body, so the thinking/search switches can be checked. */
const bodies = [];
/** Set to make the site refuse the completion: { status, body }. */
let completionFailure = null;
/** The shape the streamed reply arrives in. */
let streamShape = "pointer";
/** Whether the page renders the answer into a .ds-markdown block. */
let renderAnswer = true;
/** Whether the backend keeps what was said, for the history endpoint. */
let storeAnswers = true;
/** The shape a stored assistant message is handed back in. */
let storedShape = "text";
/** What the fake backend has stored, and the next id it would give a message. */
const messages = [];
let nextId = 6;

const page = (known) => `<!doctype html>
<html><head><meta charset="utf-8"><title>DeepSeek</title></head>
<body>
<div id="app">loading</div>
<script>
  function token() {
    try {
      const raw = localStorage.getItem('userToken');
      if (!raw) return '';
      const parsed = JSON.parse(raw);
      return parsed && parsed.value ? parsed.value : '';
    } catch (error) { return ''; }
  }
  function render() {
    if (!token()) { document.getElementById('app').textContent = 'Sign in to continue'; return; }
    document.getElementById('app').innerHTML =
      '<textarea id="chat-input" placeholder="Message DeepSeek"></textarea>' +
      '<button type="submit">Send</button>';
    const box = document.getElementById('chat-input');
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(box.value); }
    });
    document.querySelector('button').addEventListener('click', () => send(box.value));
  }
  function send(text) {
    if (!text) return;
    document.getElementById('chat-input').value = '';
    fetch('/api/v0/chat/completion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ chat_session_id: window.__chatId || null, prompt: text, thinking_enabled: false, search_enabled: true }),
    }).then((response) => {
      // The real site puts the new chat's id in the address bar straight away.
      const id = response.headers.get('x-chat-id');
      if (id) { window.__chatId = id; history.replaceState(null, '', '/a/chat/s/' + id); }
      // ...and renders the answer into the message list as it arrives.
      const rendered = response.headers.get('x-rendered');
      if (rendered) {
        const box = document.createElement('div');
        box.className = 'ds-markdown';
        for (const part of JSON.parse(atob(rendered))) {
          if (part.type === 'code') {
            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.className = 'language-' + part.lang;
            code.textContent = part.text;
            pre.appendChild(code);
            box.appendChild(pre);
          } else {
            const p = document.createElement('p');
            p.textContent = part.text;
            box.appendChild(p);
          }
        }
        document.getElementById('app').appendChild(box);
      }
      return response.text();
    }).catch(() => {});
  }
  window.__chatId = (location.pathname.match(/\\/a\\/chat\\/s\\/([0-9a-z-]+)/i) || [])[1] || '';
  // A chat that does not exist bounces back to the home screen.
  if (!${known}) { window.__chatId = ''; history.replaceState(null, '', '/'); }
  render();
</script>
</body></html>`;

const PAGE = page("true");
const MISSING_PAGE = page("false");

function envelope(data) {
  return JSON.stringify({ code: 0, msg: "ok", data: { biz_data: data } });
}

/**
 * A stored message: plain text, or the typed fragment list the site really uses
 * - reasoning and answer side by side, told apart only by their fragment type.
 */
function stored(shape, reply) {
  if (shape !== "fragments") return reply;
  return [
    { type: "THINK", content: "STORED-REASONING-SHOULD-NOT-SHOW " },
    { type: "RESPONSE", content: reply },
  ];
}

/**
 * The answer as the page would render it: prose as text, each fenced block as a
 * real <pre><code>, so the reader has to put the fences back the way the site's
 * markup makes it.
 */
function renderedHeader(reply) {
  const parts = [];
  const fenced = /```([\w+-]*)\r?\n([\s\S]*?)```/g;
  let last = 0;
  let match;
  while ((match = fenced.exec(reply)) !== null) {
    if (match.index > last) parts.push({ type: "text", text: reply.slice(last, match.index) });
    parts.push({ type: "code", lang: match[1], text: match[2] });
    last = fenced.lastIndex;
  }
  if (last < reply.length) parts.push({ type: "text", text: reply.slice(last) });
  return Buffer.from(JSON.stringify(parts)).toString("base64");
}

const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
  const url = new URL(req.url, `https://${HOST}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/a/chat/s/")) {
    const asked = url.pathname.slice("/a/chat/s/".length);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(asked === CHAT_ID ? PAGE : MISSING_PAGE);
    return;
  }

  if (url.pathname === "/api/v0/users/current") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(envelope({ id: "user-1", token: "seeded" }));
    return;
  }

  if (url.pathname === "/api/v0/chat_session/fetch_page") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      envelope({
        chat_sessions: [
          { id: CHAT_ID, title: "An earlier chat", updated_at: Math.floor(Date.now() / 1000), current_message_id: 5 },
        ],
        has_more: false,
      }),
    );
    return;
  }

  if (url.pathname === "/api/v0/chat/history_messages") {
    const asked = url.searchParams.get("chat_session_id") ?? "";
    const list =
      messages.length > 0
        ? messages
        : storeAnswers && asked === CHAT_ID
          ? [{ message_id: 5, role: "ASSISTANT", content: "Earlier answer." }]
          : [];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(envelope({ chat_messages: list }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/v0/chat/completion") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // leave it as an empty object
      }
      const index = prompts.length;
      prompts.push(String(body.prompt ?? ""));
      bodies.push(body);

      if (completionFailure !== null) {
        res.writeHead(completionFailure.status, { "content-type": "application/json" });
        res.end(completionFailure.body);
        return;
      }

      const reply = replies[index] ?? "";

      if (storeAnswers) {
        messages.push({ message_id: nextId++, role: "USER", content: String(body.prompt ?? "") });
        messages.push({ message_id: nextId++, role: "ASSISTANT", content: stored(storedShape, reply) });
      }

      const headers = { "content-type": "text/event-stream", "x-chat-id": CHAT_ID };
      if (renderAnswer) headers["x-rendered"] = renderedHeader(reply);
      res.writeHead(200, headers);

      // A turn where the stream carries the reasoning and not the answer.
      if (streamShape === "thinking-only") {
        res.end(
          [
            "event: ready",
            `data: ${JSON.stringify({ response_message_id: String(100 + index) })}`,
            `data: ${JSON.stringify({ p: "response/thinking_content", o: "APPEND", v: "SHOULD-NOT-BE-THE-ANSWER" })}`,
            `data: ${JSON.stringify({ p: "response/status", v: "FINISHED" })}`,
            "",
          ].join("\n"),
        );
        return;
      }

      // The shape the live site actually sends: typed fragments - THINK for the
      // thinking, RESPONSE for the reply - each named once, then streamed to the
      // end as `response/fragments/-1/content` appends carrying no type at all.
      // Both channels use that same append field, which is what makes a client
      // that decides the channel per chunk read the thinking as the answer.
      if (streamShape === "reasoning") {
        const half = Math.ceil(reply.length / 2);
        const append = { p: "response/fragments/-1/content", o: "APPEND" };
        res.end(
          [
            "event: ready",
            `data: ${JSON.stringify({ response_message_id: String(100 + index) })}`,
            `data: ${JSON.stringify({ p: "response/fragments", o: "APPEND", v: [{ id: 1, type: "THINK", content: "REASONING-SHOULD-NOT-SHOW " }] })}`,
            `data: ${JSON.stringify({ ...append, v: "and a command I am only thinking about:\n\n```bash\necho bad > bad-marker.txt\n```" })}`,
            `data: ${JSON.stringify({ p: "response/fragments", o: "APPEND", v: [{ id: 2, type: "RESPONSE", content: reply.slice(0, half) }] })}`,
            `data: ${JSON.stringify({ ...append, v: reply.slice(half) })}`,
            `data: ${JSON.stringify({ p: "response/status", v: "FINISHED" })}`,
            "",
          ].join("\n"),
        );
        return;
      }

      const lines = [
        "event: ready",
        `data: ${JSON.stringify({ response_message_id: String(100 + index) })}`,
        "",
      ];
      // Stream it in two pieces, the way the real endpoint does.
      const half = Math.ceil(reply.length / 2);
      for (const part of [reply.slice(0, half), reply.slice(half)]) {
        if (part === "") continue;
        // The site sends fragments; the plain pointer shape has to keep working.
        lines.push(
          streamShape === "fragments"
            ? `data: ${JSON.stringify({ p: "response/fragments", o: "APPEND", v: [{ type: "text", content: part }] })}`
            : `data: ${JSON.stringify({ p: "response/content", o: "APPEND", v: part })}`,
        );
      }
      lines.push(`data: ${JSON.stringify({ p: "response/status", v: "FINISHED" })}`, "");

      res.end(streamShape === "none" ? "" : lines.join("\n"));
    });
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: 404, msg: "not found" }));
});

await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

/* ------------------------------------------------------------------ */
/* a launch wrapper that points the hostname at the fake site          */
/* ------------------------------------------------------------------ */

function findBrowser() {
  const configured = (process.env.ANYAGENT_TEST_BROWSER ?? "").trim();
  if (configured !== "") return configured;
  for (const name of [
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "microsoft-edge",
    "/repl/tools/bin/chromium",
  ]) {
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (dir !== "" && fs.existsSync(path.join(dir, name))) return path.join(dir, name);
    }
    if (name.startsWith("/") && fs.existsSync(name)) return name;
  }
  // Last resort: the Chromium Playwright downloaded, if it is there.
  try {
    const bundled = chromium.executablePath();
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {
    // not installed
  }
  return "";
}

const browser = findBrowser();
if (browser === "") {
  console.log("\nSkipped: no Chromium-family browser found.\n");
  console.log("Set ANYAGENT_TEST_BROWSER, or run: npx playwright install chromium\n");
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(0);
}

const wrapper = path.join(work, "browser.sh");
fs.writeFileSync(
  wrapper,
  `#!/bin/sh\nexec ${browser} "$@" --host-resolver-rules="MAP ${HOST} 127.0.0.1:${PORT}" --ignore-certificate-errors\n`,
  { mode: 0o755 },
);

const project = path.join(work, "project");
fs.mkdirSync(project, { recursive: true });

const cliEnv = {
  ...process.env,
  DEEPSEEK_SESSION_JSON: JSON.stringify({
    authorization: "Bearer seeded-token",
    cookie: "ds_session_id=seeded; aws-waf-token=seeded",
  }),
  ANYAGENT_PROFILE_DIR: path.join(work, "profile"),
  ANYAGENT_BROWSER_PATH: wrapper,
  ANYAGENT_PACE_MS: "0",
};

function runCli(args, input, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "dist/cli.js"), ...args], {
      cwd: ROOT,
      env: { ...cliEnv, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const SETUP_MARKER = "fresh bash";

/* ------------------------------------------------------------------ */
console.log("\n== one task, end to end ==\n");
/* ------------------------------------------------------------------ */

replies = [
  "Let me write that file.\n\n```bash\nprintf 'Hello World' > hello.txt && wc -c < hello.txt\n```",
  "Created `hello.txt` with Hello World.",
];

const first = await runCli(["--cwd", project, "create a file called hello.txt containing Hello World"]);

await test("the CLI finished cleanly", () => {
  assert.equal(first.code, 0, first.out + first.err);
  assert.equal(first.err.trim(), "", `unexpected stderr: ${first.err}`);
});

await test("the model was asked twice: once with the command, once with its output", () => {
  assert.equal(prompts.length, 2, `prompts: ${JSON.stringify(prompts)}`);
});

await test("the first message is the setup and the task", () => {
  assert.match(prompts[0], /create a file called hello\.txt/);
  assert.match(prompts[0], new RegExp(project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompts[0], /No block means you are done/);
});

await test("what got typed back is the output, and nothing else", () => {
  assert.equal(prompts[1], "11", `got: ${JSON.stringify(prompts[1])}`);
});

await test("the command really ran, in the working directory", () => {
  assert.equal(fs.readFileSync(path.join(project, "hello.txt"), "utf8"), "Hello World");
});

await test("the CLI showed the command and its result", () => {
  assert.match(first.out, /-> \$ printf 'Hello World' > hello\.txt/);
  assert.match(first.out, /ok/);
});

await test("the final answer is shown", () => {
  assert.match(first.out, /Created `hello\.txt` with Hello World\./);
});

await test("the banner names the browser in use and where the sign-in came from", () => {
  // The browser is a wrapper here, so it is reported by name and as configured.
  assert.match(first.out, /Backend:\s+chat\.deepseek\.com \(browser\.sh \(configured\), hidden\)/);
  assert.match(first.out, /Login:\s+.*DEEPSEEK_SESSION_JSON/);
});

await test("the fake site confirmed the captured credentials signed the browser in", () => {
  // The page only renders a composer when the seeded token is in local storage.
  assert.equal(prompts.length, 2);
});

await test("thinking is on and search is off, on the wire", () => {
  assert.equal(bodies[0].thinking_enabled, true);
  assert.equal(bodies[0].search_enabled, false);
});

await test("a brand-new chat has no id yet, and the banner says so", () => {
  assert.match(first.out, /Session:\s+\(new chat\)/);
});

/* ------------------------------------------------------------------ */
console.log("\n== a second task in a chat that is already open ==\n");
/* ------------------------------------------------------------------ */

prompts.length = 0;
messages.length = 0;
nextId = 6;
replies = [
  "Looking now.\n\n```bash\npwd\n```",
  "You are in the project directory.",
];

const second = await runCli(["--cwd", project, "--session", CHAT_ID, "where am I?"]);

await test("a resumed chat does not repeat the setup", () => {
  assert.equal(prompts[0], "where am I?", `got: ${JSON.stringify(prompts[0])}`);
  assert.doesNotMatch(prompts[0], new RegExp(SETUP_MARKER));
});

await test("the command result is still pasted back", () => {
  assert.equal(prompts[1], project);
});

await test("resuming worked and the answer is shown", () => {
  assert.equal(second.code, 0, second.out + second.err);
  assert.match(second.out, /You are in the project directory\./);
  assert.match(second.out, new RegExp(CHAT_ID.slice(0, 8)));
});

/* ------------------------------------------------------------------ */
console.log("\n== a failing command goes back to the model ==\n");
/* ------------------------------------------------------------------ */

prompts.length = 0;
messages.length = 0;
nextId = 6;
replies = [
  "Trying that path.\n\n```bash\ncat /no/such/file\n```",
  "That file is not there.",
];

const third = await runCli(["--cwd", project, "read that file"]);

await test("the failure is reported, not hidden", () => {
  assert.match(prompts[1], /No such file or directory/);
  assert.match(prompts[1], /\(exit code 1\)/);
});

await test("the CLI shows the failure", () => {
  assert.match(third.out, /exit 1/);
});

await test("the model was given the chance to react to it", () => {
  assert.match(third.out, /That file is not there\./);
});

/* ------------------------------------------------------------------ */
console.log("\n== a block fenced for Windows runs anyway ==\n");
/* ------------------------------------------------------------------ */

// A model on Windows fences the command `cmd` whatever the setup asked for.
// Passing that over as prose is a command that never runs, which looks from the
// outside exactly like an agent that does not execute anything.
prompts.length = 0;
messages.length = 0;
nextId = 6;
replies = [
  "Running it the Windows way.\n\n```cmd\necho from-cmd-block > cmd-marker.txt && cat cmd-marker.txt\n```",
  'Done - it printed from-cmd-block.\n\n```json\n{"ran": true}\n```',
];

const winFenced = await runCli(["--cwd", project, "run it the windows way"]);

await test("the command in the cmd block reached the shell", () => {
  assert.equal(prompts.length, 2, `prompts: ${JSON.stringify(prompts)}`);
  assert.match(prompts[1], /from-cmd-block/);
});

await test("the CLI showed it running", () => {
  assert.match(winFenced.out, /\$ echo from-cmd-block/);
  assert.ok(fs.existsSync(path.join(project, "cmd-marker.txt")), "the command really ran");
});

await test("it names the block it did not run, instead of staying silent", () => {
  assert.match(winFenced.out, /the ```json block was not run/);
});

/* ------------------------------------------------------------------ */
console.log("\n== the model shows something without asking for a command ==\n");
/* ------------------------------------------------------------------ */

prompts.length = 0;
messages.length = 0;
nextId = 6;
replies = ['The config is:\n\n```json\n{"port": 3000}\n```\n\nAnything else?'];

const fourth = await runCli(["--cwd", project, "show me the config"]);

await test("nothing was run and nothing was sent back", () => {
  assert.equal(prompts.length, 1, `prompts: ${JSON.stringify(prompts)}`);
});

await test("the answer keeps what the model showed us", () => {
  assert.match(fourth.out, /"port": 3000/);
  assert.match(fourth.out, /Anything else\?/);
});

/* ------------------------------------------------------------------ */
console.log("\n== interactive mode ==\n");
/* ------------------------------------------------------------------ */

prompts.length = 0;
messages.length = 0;
nextId = 6;
replies = [
  "Checking.\n\n```bash\necho from-the-shell\n```",
  "All done here.",
  "Second task noted.",
];

const interactive = await runCli(["--cwd", project], "0\nlist the files\nand again\n/exit\n");

await test("the session picker is offered before the banner", () => {
  assert.match(interactive.out, /Sessions on chat\.deepseek\.com/);
  assert.match(interactive.out, /An earlier chat/);
  assert.match(interactive.out, /Pick \[0\]/);
});

await test("both tasks ran in the one process", () => {
  assert.equal(prompts.length, 3, `prompts: ${JSON.stringify(prompts)}`);
  assert.match(prompts[0], /list the files/);
  assert.equal(prompts[1], "from-the-shell");
  assert.equal(prompts[2], "and again");
});

await test("the banner is printed once", () => {
  assert.equal(interactive.out.match(/Backend:\s+chat\.deepseek\.com/g).length, 1);
});

await test("/exit quits", () => {
  assert.match(interactive.out, /Bye\./);
  assert.equal(interactive.code, 0, interactive.out + interactive.err);
});

/* ------------------------------------------------------------------ */
console.log("\n== where the answer is read from ==\n");
/* ------------------------------------------------------------------ */

// Each reading has to stand on its own, because any one of them can fail while
// the others are fine. A stream whose chunks we do not recognise used to parse
// to an empty turn, which looked exactly like a site that said nothing.

prompts.length = 0;
messages.length = 0;
nextId = 6;
replies = [
  "Writing it now.\n\n```bash\nprintf 'Fragments' > frag.txt && cat frag.txt\n```",
  "Done - it printed Fragments.",
];
renderAnswer = false;
storeAnswers = false;
streamShape = "fragments";
const fragments = await runCli(["--cwd", project, "write it from a fragments stream"]);

await test("a fragment-shaped stream is read, not dropped on the floor", () => {
  assert.equal(fragments.code, 0, fragments.out + fragments.err);
  assert.equal(prompts.length, 2, `prompts: ${JSON.stringify(prompts)}`);
  assert.equal(prompts[1], "Fragments");
  assert.ok(fs.existsSync(path.join(project, "frag.txt")), "the command really ran");
});

prompts.length = 0;
messages.length = 0;
nextId = 6;
replies = ["Reading it off the page.\n\n```bash\necho from-the-page\n```", "It came from the page."];
renderAnswer = true;
storeAnswers = false;
streamShape = "none";
const pageOnly = await runCli(["--cwd", project, "answer off the page"]);

await test("the answer is read off the page when the response carries nothing", () => {
  assert.equal(pageOnly.code, 0, pageOnly.out + pageOnly.err);
  assert.equal(prompts[1], "from-the-page");
  assert.match(pageOnly.out, /It came from the page\./);
});

prompts.length = 0;
messages.length = 0;
nextId = 6;
replies = ["It is stored.\n\n```bash\necho from-the-chat\n```", "It came from the stored chat."];
renderAnswer = false;
storeAnswers = true;
streamShape = "none";
const storedOnly = await runCli(["--cwd", project, "answer from the stored chat"]);

await test("the answer is read from what the chat stored when the page shows nothing", () => {
  assert.equal(storedOnly.code, 0, storedOnly.out + storedOnly.err);
  assert.equal(prompts[1], "from-the-chat");
  assert.match(storedOnly.out, /It came from the stored chat\./);
});

prompts.length = 0;
messages.length = 0;
nextId = 6;
replies = ["Thinking hard.\n\n```bash\necho real-answer\n```", "That was the real answer."];
renderAnswer = true;
storeAnswers = false;
streamShape = "thinking-only";
const thinkingOnly = await runCli(["--cwd", project, "do not read my thoughts"]);

await test("reasoning in the stream is never taken for the answer", () => {
  assert.equal(thinkingOnly.code, 0, thinkingOnly.out + thinkingOnly.err);
  assert.equal(prompts[1], "real-answer", "the thinking must not be what the loop acts on");
  assert.doesNotMatch(thinkingOnly.out, /SHOULD-NOT-BE-THE-ANSWER/);
});

// The real stream sends reasoning and answer together, as fragments that only
// their type tells apart - and the type is named once, at the start of each. Miss
// that and the model's private thoughts are shown to the user as its reply, and a
// fenced command inside them is run as though the model had asked for it.
prompts.length = 0;
messages.length = 0;
nextId = 6;
replies = [
  "Understood - that is a greeting.\n\n```bash\necho GOOD-MARKER > good-marker.txt && cat good-marker.txt\n```",
  "Done: I wrote good-marker.txt.",
];
renderAnswer = false;
storeAnswers = false;
streamShape = "reasoning";
const reasoning = await runCli(["--cwd", project, "greet me"]);
streamShape = "pointer";
renderAnswer = true;
storeAnswers = true;

await test("the model's reasoning is not shown to the user as its answer", () => {
  assert.equal(reasoning.code, 0, reasoning.out + reasoning.err);
  assert.doesNotMatch(reasoning.out, /REASONING-SHOULD-NOT-SHOW/);
  assert.equal(prompts[1], "GOOD-MARKER", `got: ${JSON.stringify(prompts[1])}`);
});

await test("a command that only appeared in the reasoning is not run", () => {
  assert.ok(
    !fs.existsSync(path.join(project, "bad-marker.txt")),
    "a command the model was only thinking about really ran",
  );
  assert.ok(fs.existsSync(path.join(project, "good-marker.txt")), "the command it did ask for ran");
});

// A message that came back from the chat's own history is a list of typed
// fragments too, and reading all of it is the same mistake by another door.
prompts.length = 0;
messages.length = 0;
nextId = 6;
replies = ["It is stored, and that is all I have to say."];
renderAnswer = false;
storeAnswers = true;
storedShape = "fragments";
streamShape = "none";
const storedMessage = await runCli(["--cwd", project, "say what is stored"]);
storedShape = "text";
streamShape = "pointer";
renderAnswer = true;

await test("a stored message keeps its reasoning out of the answer", () => {
  assert.equal(storedMessage.code, 0, storedMessage.out + storedMessage.err);
  assert.match(storedMessage.out, /It is stored, and that is all I have to say\./);
  assert.doesNotMatch(storedMessage.out, /STORED-REASONING-SHOULD-NOT-SHOW/);
});

prompts.length = 0;
messages.length = 0;
nextId = 6;
replies = [];
renderAnswer = false;
storeAnswers = false;
streamShape = "none";
const unreadable = await runCli(["--cwd", project, "say something"]);

streamShape = "pointer";
renderAnswer = true;
storeAnswers = true;

await test("a turn nothing could be read from keeps the response for evidence", () => {
  const seen = unreadable.out + unreadable.err;
  assert.notEqual(unreadable.code, 0);
  assert.match(seen, /Nothing came back from DeepSeek for this turn/);
  assert.ok(
    fs.existsSync(path.join(work, "profile", "last-turn.txt")),
    "the response is saved so its shape can be looked at",
  );
});

/* ------------------------------------------------------------------ */
console.log("\n== a turn the backend answers with a refusal ==\n");
/* ------------------------------------------------------------------ */

// DeepSeek reports a rejected session in the body with HTTP 200, so a client
// that only reads the stream sees an empty turn and reports nothing useful.
prompts.length = 0;
messages.length = 0;
nextId = 6;
replies = [];
completionFailure = {
  status: 200,
  body: JSON.stringify({ code: 40003, msg: "Authorization Failed (invalid token)" }),
};
const refused = await runCli(["--cwd", project, "do something"]);
completionFailure = null;

await test("a refusal in the body is reported, not swallowed as an empty turn", () => {
  const seen = refused.out + refused.err;
  assert.notEqual(refused.code, 0);
  assert.match(seen, /40003/);
  assert.match(seen, /Authorization Failed/);
  assert.match(seen, /re-capture/i);
});

prompts.length = 0;
messages.length = 0;
nextId = 6;
replies = [];
completionFailure = { status: 503, body: "<html><body>Service Unavailable</body></html>" };
const unavailable = await runCli(["--cwd", project, "do something"]);
completionFailure = null;

await test("an HTTP failure says the status and shows what came back", () => {
  const seen = unavailable.out + unavailable.err;
  assert.notEqual(unavailable.code, 0);
  assert.match(seen, /HTTP 503/);
  assert.match(seen, /Service Unavailable/);
});

await test("the failure says how to watch the hidden browser", () => {
  assert.match(refused.out + refused.err, /ANYAGENT_HEADLESS=0/);
});

/* ------------------------------------------------------------------ */
console.log("\n== asking for a browser that is not here ==\n");
/* ------------------------------------------------------------------ */

const wrongBrowser = await runCli(["--cwd", project, "hi"], undefined, {
  ANYAGENT_BROWSER: "netscape",
  ANYAGENT_BROWSER_PATH: "",
});

await test("says the named browser is missing instead of using another one", () => {
  const seen = wrongBrowser.out + wrongBrowser.err;
  assert.notEqual(wrongBrowser.code, 0);
  assert.match(seen, /ANYAGENT_BROWSER=netscape/);
  assert.match(seen, /no such browser is installed/);
  assert.match(seen, /ANYAGENT_BROWSER_PATH/);
});

/* ------------------------------------------------------------------ */
console.log("\n== a session that cannot be continued ==\n");
/* ------------------------------------------------------------------ */

prompts.length = 0;
messages.length = 0;
nextId = 6;
replies = ["Fine."];
const bad = await runCli(["--cwd", project, "--session", "99999999-9999-9999-9999-999999999999", "hello"]);

await test("says the chat could not be opened instead of pretending", () => {
  assert.notEqual(bad.code, 0);
  assert.match(bad.out + bad.err, /did not open chat|99999999/);
});

/* ------------------------------------------------------------------ */

await new Promise((resolve) => server.close(resolve));
if (failures.length === 0) fs.rmSync(work, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  console.log(`artifacts kept in ${work}\n`);
  for (const failure of failures) console.log(`FAILED: ${failure.name}\n${failure.error.stack}\n`);
  process.exit(1);
}
