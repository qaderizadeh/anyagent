/**
 * Offline tests: no network, no backend.
 *
 *   node test-agent.mjs            (or: npm test)
 *
 * They cover the two things that decide whether a run works: which text in a
 * reply is a command, and which text in the stream is the answer.
 */

import { commandIn, blocks, proseOf, runShell, pasteBack, STARTER, shellName } from "./dist/agent.js";
import { createStreamReader, BizError } from "./dist/deepseek.js";

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
/* the starter prompt                                                  */
/* ------------------------------------------------------------------ */

check("the starter asks for one command at a time", STARTER.includes("only one command in a single `sh` block at a time"));
check("the starter says the output gets pasted back", STARTER.includes("paste the output back to you"));
check("the starter says a reply may have no block", STARTER.includes("otherwise"));

/* ------------------------------------------------------------------ */
/* which block is the command                                          */
/* ------------------------------------------------------------------ */

const one = (reply) => commandIn(reply).command;

check("a ```sh block is the command", one("Let me look.\n\n```sh\nls -la\n```\n") === "ls -la");
check("a ```bash block is too", one("```bash\npwd\n```") === "pwd");
check("```cmd works on Windows", one("```cmd\ndir /a\n```") === "dir /a");
check("```powershell works too", one("```powershell\nGet-Date\n```") === "Get-Date");
check("an untagged block is a command", one("```\nwhoami\n```") === "whoami");
check("```cmd.exe is recognised", one("```cmd.exe\ndir\n```") === "dir");
check("```{.sh} is recognised", one("```{.sh}\ndate\n```") === "date");
check("a tag with a word after it is recognised", one("```cmd (Windows)\ndir\n```") === "dir");

check("```json is not a command", one("Here is the config:\n\n```json\n{\"a\":1}\n```") === "");
check("```text is not a command", one("```text\njust prose\n```") === "");
check("```python is not a command", one("```python\nprint(1)\n```") === "");
check("a skipped snippet is reported", commandIn("```json\n{}\n```").skipped.includes("json"));

check(
  "the command is found even when a snippet comes first",
  one("```json\n{}\n```\n\n```sh\nls\n```") === "ls",
);
check("an unclosed block still yields its command", one("Working on it.\n\n```sh\necho hi") === "echo hi");
check("CRLF endings do not break the command", one("```sh\r\necho hi\r\n```") === "echo hi");
check("no block means no command", one("All done, nothing to run.") === "");
check("two commands: the first one is used", one("```sh\none\n```\n```sh\ntwo\n```") === "one");

check("a copied $ prompt is stripped", one("```sh\n$ ls -la\n```") === "ls -la");
check("a copied > prompt is stripped", one("```sh\n> pwd\n```") === "pwd");
check(
  "a copied Windows prompt is stripped",
  one("```sh\nC:\\Users\\asli> dir /a\n```") === "dir /a",
);

check("the fence is not shown as prose", proseOf("I will look.\n\n```sh\nls\n```") === "I will look.");
check("conversational prose is kept", proseOf("Hello.") === "Hello.");
check("blocks() finds both blocks", blocks("```json\n{}\n```\n```sh\nls\n```").length === 2);

/* ------------------------------------------------------------------ */
/* the shell runner                                                    */
/* ------------------------------------------------------------------ */

const run = (command) => runShell(command, process.cwd());

const ok = await run('node -e "console.log(\'hello from the shell\')"');
check("the command's output comes back", ok.output.includes("hello from the shell"));
check("a success reports exit code 0", ok.code === 0);

const bad = await run('node -e "process.exit(3)"');
check("a failing command reports its exit code", bad.code === 3);

const noisy = await run('node -e "console.error(\'BOOM\')"');
check("stderr is kept, never hidden", noisy.output.includes("BOOM"));

const quiet = await run('node -e ""');
check("a silent command is not an error", quiet.code === 0 && quiet.output.trim() === "");

check("the output is pasted back with the exit code", pasteBack(ok).endsWith("Process exited with 0"));
check("empty output still says it exited", pasteBack(quiet).includes("(no output)"));

check("the shell has a name for the banner", shellName().length > 0);

/* ------------------------------------------------------------------ */
/* reading the reply out of a stream                                   */
/* ------------------------------------------------------------------ */

const read = (items) => {
  const reader = createStreamReader();
  for (const item of items) reader.feed(`data: ${JSON.stringify(item)}`);
  return { text: reader.text(), id: reader.messageId() };
};

// The real shape: a typed fragment list, then content-only appends that do NOT
// repeat the type. Joining everything is how the model's thinking leaks into
// the answer and gets run as a command, so this is the test that matters.
const fragments = read([
  { p: "response/fragments", o: "APPEND", v: [{ id: 1, type: "THINK", content: "Let me check." }] },
  { p: "response/fragments/-1/content", o: "APPEND", v: " First the file list." },
  { p: "response/fragments", o: "APPEND", v: [{ id: 2, type: "RESPONSE", content: "Here it is." }] },
  { p: "response/fragments/-1/content", o: "APPEND", v: " Anything else?" },
  { p: "response/status", v: "FINISHED" },
]);
check("the reply is read, and the thinking is not", fragments.text === "Here it is. Anything else?");

const leak = read([
  { p: "response/fragments", o: "APPEND", v: [{ id: 1, type: "THINK", content: "```sh\nrm -rf /\n```" }] },
  { p: "response/fragments/-1/content", o: "APPEND", v: " that would be bad." },
  { p: "response/fragments", o: "APPEND", v: [{ id: 2, type: "RESPONSE", content: "I will not run that." }] },
]);
check("a command that only appears in the thinking is not in the answer", !leak.text.includes("rm -rf"));

const unknown = read([
  { p: "response/fragments", o: "APPEND", v: [{ id: 1, type: "SEARCH", content: "searching the web..." }] },
  { p: "response/fragments", o: "APPEND", v: [{ id: 2, type: "RESPONSE", content: "Found it." }] },
]);
check("a fragment kind that is not the reply carries nothing", unknown.text === "Found it.");

const legacy = read([
  { p: "response/content", o: "APPEND", v: "Hello" },
  { p: "response/content", o: "APPEND", v: ", world" },
]);
check("response/content appends are read", legacy.text === "Hello, world");

const set = read([{ p: "response/content", o: "SET", v: "only this" }]);
check("a SET replaces what was there", set.text === "only this");

const snapshot = read([{ p: "response/content", v: { response: { content: "the whole message", message_id: 42 } } }]);
check("a whole-message snapshot is read", snapshot.text === "the whole message");
check("the snapshot also carries the message id", snapshot.id === "42");

const thinking = read([
  { p: "response/thinking_content", o: "APPEND", v: "the model's private reasoning" },
  { p: "response/content", o: "APPEND", v: "the answer" },
]);
check("thinking_content is dropped", thinking.text === "the answer");

const jsonFragments = read([
  { p: "response/fragments", o: "APPEND", v: '[{"type":"RESPONSE","content":"as a string"}]' },
]);
check("a fragment list sent as a JSON string is read", jsonFragments.text === "as a string");

const ready = (() => {
  const reader = createStreamReader();
  reader.feed("event: ready");
  reader.feed('data: {"response_message_id": 11}');
  reader.feed('data: {"p":"response/content","v":"hi"}');
  return reader.messageId();
})();
check("the message id from the ready event is kept", ready === "11");

const busy = read([
  { p: "response/status", v: "FINISHED" },
  { p: "response/quota", v: "5" },
]);
check("status and counters are not mistaken for the answer", busy.text === "");

let threw = null;
try {
  read([{ p: "response/content", v: "x", biz_code: 40003, biz_msg: "Authorization Failed" }]);
} catch (error) {
  threw = error;
}
check("an error inside the stream is raised, not read as an empty reply", threw instanceof BizError && threw.code === 40003);

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
