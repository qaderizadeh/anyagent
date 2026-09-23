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
    res.writeHead(200, { "content-type": "application/json" });
    res.end(envelope({ chat_messages: [{ message_id: 5, role: "ASSISTANT", content: "Earlier answer." }] }));
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
      const lines = [
        "event: ready",
        `data: ${JSON.stringify({ response_message_id: String(100 + index) })}`,
        "",
      ];
      // Stream it in two pieces, the way the real endpoint does.
      const half = Math.ceil(reply.length / 2);
      for (const part of [reply.slice(0, half), reply.slice(half)]) {
        if (part === "") continue;
        lines.push(`data: ${JSON.stringify({ p: "response/content", o: "APPEND", v: part })}`);
      }
      lines.push(`data: ${JSON.stringify({ p: "response/status", v: "FINISHED" })}`, "");

      res.writeHead(200, { "content-type": "text/event-stream", "x-chat-id": CHAT_ID });
      res.end(lines.join("\n"));
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
console.log("\n== a turn the backend answers with a refusal ==\n");
/* ------------------------------------------------------------------ */

// DeepSeek reports a rejected session in the body with HTTP 200, so a client
// that only reads the stream sees an empty turn and reports nothing useful.
prompts.length = 0;
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
