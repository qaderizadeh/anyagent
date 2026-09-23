/**
 * End-to-end test: the real CLI, talking real HTTP to a stand-in chat.deepseek.com.
 *
 *   node test-http.mjs          (or: npm test)
 *
 * Nothing is mocked inside the app — the transport, the proof-of-work solver,
 * the reply parsing and the shell runner all run for real. Only the server on
 * the other end is ours, so the whole path can be checked without an account.
 * ANYAGENT_HOST is what points the app here.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`ok    ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}`);
  }
}

/* ------------------------------------------------------------------ */
/* a stand-in chat.deepseek.com                                        */
/* ------------------------------------------------------------------ */

const CHALLENGE = {
  algorithm: "sha3",
  challenge: "abcdef",
  salt: "salt",
  expire_at: 0,
  difficulty: 1,
  signature: "sig",
  target_path: "/api/v0/chat/completion",
};

const OK = (biz_data) => JSON.stringify({ code: 0, data: { biz_data } });

/** Turn 1 asks for a command; the thinking in the same reply holds a command too. */
const TURN_ONE = [
  "event: ready",
  'data: {"response_message_id": 11}',
  "",
  `data: ${JSON.stringify({
    p: "response/fragments",
    o: "APPEND",
    v: [
      {
        id: 1,
        type: "THINK",
        content: "A marker file. I could run:\n\n```sh\necho wrong > wrong.txt\n```\nbut let me use node.",
      },
    ],
  })}`,
  "",
  `data: ${JSON.stringify({ p: "response/fragments/-1/content", o: "APPEND", v: " Choosing node." })}`,
  "",
  `data: ${JSON.stringify({
    p: "response/fragments",
    o: "APPEND",
    v: [
      {
        id: 2,
        type: "RESPONSE",
        content: 'Writing the marker file.\n\n```sh\nnode -e "require(\'fs\').writeFileSync(\'marker.txt\',\'ok\')"\n```',
      },
    ],
  })}`,
  "",
  `data: ${JSON.stringify({ p: "response/status", v: "FINISHED" })}`,
  "",
  "data: [DONE]",
  "",
];

const TURN_TWO = [
  `data: ${JSON.stringify({
    p: "response/fragments",
    o: "APPEND",
    v: [{ id: 3, type: "RESPONSE", content: "Done - marker.txt is in place." }],
  })}`,
  "",
  "data: [DONE]",
  "",
];

const prompts = [];
let completions = 0;
let mode = "ok";

const server = http.createServer((request, response) => {
  const body = [];
  request.on("data", (chunk) => body.push(chunk));
  request.on("end", () => {
    const url = request.url ?? "";
    const send = (text, type = "application/json") => {
      response.writeHead(200, { "content-type": type });
      response.end(text);
    };

    if (url.startsWith("/api/v0/users/current")) return send(OK({}));
    if (url.startsWith("/api/v0/chat_session/fetch_page")) return send(OK({ chat_sessions: [] }));
    if (url.startsWith("/api/v0/chat_session/create")) return send(OK({ id: "stand-in-chat" }));
    if (url.startsWith("/api/v0/chat/history_messages")) return send(OK({ chat_messages: [] }));
    if (url.startsWith("/api/v0/chat/create_pow_challenge")) return send(OK({ challenge: CHALLENGE }));

    if (url.startsWith("/api/v0/chat/completion")) {
      const sent = JSON.parse(Buffer.concat(body).toString() || "{}");
      prompts.push(sent.prompt ?? "");
      if (mode === "refuse") {
        // A refusal is reported in the body with HTTP 200, not an error status.
        return send(JSON.stringify({ code: 0, data: { biz_code: 40003, biz_msg: "Authorization Failed" } }));
      }
      const turn = completions++;
      return send(turn === 0 ? TURN_ONE.join("\n") : TURN_TWO.join("\n"), "text/event-stream");
    }

    response.writeHead(404);
    response.end();
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const host = `http://127.0.0.1:${server.address().port}`;

/** Run the real CLI, the way a user would. */
function cli(task, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/cli.js", task, "--cwd", cwd], {
      env: {
        ...process.env,
        ANYAGENT_HOST: host,
        DEEPSEEK_SESSION_JSON: '{"authorization":"Bearer stand-in","cookie":"ds_session_id=stand-in"}',
        DEEPSEEK_POW_WASM_PATH: path.resolve("sha3_wasm_bg.wasm"),
        DEEPSEEK_THINKING_ENABLED: "1",
      },
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code, out }));
  });
}

/* ------------------------------------------------------------------ */
/* a task: one command, then an answer                                 */
/* ------------------------------------------------------------------ */

const work = mkdtempSync(path.join(os.tmpdir(), "anyagent-"));
const run = await cli("make me a marker file", work);
if (run.code !== 0) console.log(`--- CLI said ---\n${run.out}\n---`);

check("the CLI exits cleanly", run.code === 0);
check("the banner names the build", run.out.includes("AnyAgent 5.0.0"));
check("the command is shown as it runs", run.out.includes("-> $ node -e"));
check("the result is shown", run.out.includes("ok"));
check("the final answer is printed", run.out.includes("Done - marker.txt is in place."));

check("the command really ran", existsSync(path.join(work, "marker.txt")));
check("the file holds what the command wrote", readFileSync(path.join(work, "marker.txt"), "utf8") === "ok");
check("a command from the model's thinking was NOT run", !existsSync(path.join(work, "wrong.txt")));
check("the thinking is not shown as the answer", !run.out.includes("Choosing node."));

check("the chat was started from scratch", completions === 2);
check("the first message is the starter and the task", prompts[0].includes("only one command in a single `sh` block"));
check("the task is in the first message", prompts[0].includes("make me a marker file"));
check(
  "only the output goes back, and the exit code with it",
  prompts[1] === "(no output)\nProcess exited with 0",
);

/* ------------------------------------------------------------------ */
/* a refused turn, reported instead of looking empty                   */
/* ------------------------------------------------------------------ */

mode = "refuse";
const refused = await cli("say hi", work);

check("a refusal is not a crash", refused.code === 1);
check("the refusal code is reported", refused.out.includes("40003"));
check("the refusal reason is reported", refused.out.includes("Authorization Failed"));

/* ------------------------------------------------------------------ */

server.close();
rmSync(work, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
