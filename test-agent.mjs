/**
 * Tests for the human-simulation protocol.
 *
 * The heart of this version is: a normal chat reply, a fenced command inside
 * it, and the terminal output pasted back. None of that needs a browser, so
 * the loop runs against a stub chat that records every prompt it is sent.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Read when the module loads, so set them before importing it.
process.env.DEEPSEEK_MAX_ITERATIONS = "6";
process.env.DEEPSEEK_SHELL_TIMEOUT_MS = "1500";

const { Agent, commandIn, isWslStub, paste, proseOf, resolveShell, runShell, setup, shellFor, shellName, unrunTags } =
  await import("./dist/agent.js");
const { parseStream } = await import("./dist/browser.js");

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${error.message.split("\n")[0]}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${error.message.split("\n")[0]}`);
  }
}

/* ------------------------------------------------------------------ */
console.log("\n== the setup blurb ==\n");
/* ------------------------------------------------------------------ */

test("names the machine, the shell, the directory and the fence", () => {
  const text = setup("/home/me/project");
  assert.match(text, /Linux|macOS|Windows/);
  assert.match(text, new RegExp(shellName()));
  assert.match(text, /\/home\/me\/project/);
  assert.match(text, new RegExp("```" + shellName()));
});

test("says that no block means the end", () => {
  assert.match(setup("/tmp"), /No block means you are done/);
});

test("is short", () => {
  const lines = setup("/home/me/project").split("\n");
  assert.ok(lines.length <= 5, `expected <= 5 lines, got ${lines.length}`);
});

/* ------------------------------------------------------------------ */
console.log("\n== pulling the command out of a reply ==\n");
/* ------------------------------------------------------------------ */

test("takes the command out of a bash block", () => {
  const reply = "Let me check.\n\n```bash\nls -la\n```\n";
  assert.equal(commandIn(reply), "ls -la");
});

test("accepts a bare fence", () => {
  assert.equal(commandIn("```\nwhoami\n```"), "whoami");
});

test("accepts sh, zsh and shell tags", () => {
  for (const tag of ["sh", "zsh", "shell", "bash"]) {
    assert.equal(commandIn(`\`\`\`${tag}\ndate\n\`\`\``), "date", tag);
  }
});

test("accepts a tilde fence", () => {
  assert.equal(commandIn("~~~bash\ndate\n~~~"), "date");
});

test("keeps a multi-line block together", () => {
  const reply = "```bash\ncd /tmp && pwd\nls\n```";
  assert.equal(commandIn(reply), "cd /tmp && pwd\nls");
});

test("still uses a fence the model forgot to close", () => {
  assert.equal(commandIn("Sure:\n\n```bash\nuname -a\n"), "uname -a");
});

test("shrinks to nothing when there is no block", () => {
  assert.equal(commandIn("The task is complete."), "");
});

test("ignores a block that is not a shell command", () => {
  assert.equal(commandIn("Here is the JSON:\n\n```json\n{\"a\": 1}\n```"), "");
  assert.equal(commandIn("```python\nprint(1)\n```"), "");
  assert.equal(commandIn("```text\nsome output\n```"), "");
});

test("drops a terminal prompt copied into the block", () => {
  assert.equal(commandIn("```bash\n$ ls -la\n```"), "ls -la");
  assert.equal(commandIn("```bash\n$ cd /tmp\n$ pwd\n```"), "cd /tmp\npwd");
});

test("leaves a block alone when it only looks prompt-like", () => {
  // A path or a shell variable starting with $ is a command, not a prompt.
  assert.equal(commandIn("```bash\n$HOME/bin/run\n```"), "$HOME/bin/run");
});

test("runs one block at a time, not all of them", () => {
  const reply = "First:\n\n```bash\necho one\n```\n\nOr maybe:\n\n```bash\necho two\n```";
  assert.equal(commandIn(reply), "echo one");
});

test("prefers a shell block over a non-shell one", () => {
  const reply = "```json\n{\"n\": 1}\n```\n\n```bash\necho hi\n```";
  assert.equal(commandIn(reply), "echo hi");
});

test("does not treat an inline code span as a block", () => {
  assert.equal(commandIn("Use ```bash``` for that."), "");
});

/* ------------------------------------------------------------------ */
console.log("\n== Windows ==\n");
/* ------------------------------------------------------------------ */

test("takes the command out of a block fenced for Windows", () => {
  for (const tag of ["cmd", "bat", "batch", "dos", "powershell", "ps1", "pwsh"]) {
    assert.equal(commandIn(`\`\`\`${tag}\ndir\n\`\`\``), "dir", tag);
  }
});

// The tag a model writes varies with no warning, and every variant it writes
// that we treat as prose is a command that never runs.
test("reads a Windows tag however it is written", () => {
  const tags = [
    "CMD", "cmd.exe", "cmd-script", "{.cmd}", "cmd (Windows)", " cmd ",
    "win", "windows", "command", "command-prompt", "powershell.exe", "pwsh.exe",
    "PowerShell", "windows powershell",
  ];
  for (const tag of tags) assert.equal(commandIn(`\`\`\`${tag}\ndir\n\`\`\``), "dir", tag);
});

test("runs a Windows block in the shell it names", () => {
  assert.match(shellFor("cmd", true), /cmd(\.exe)?$/i);
  assert.match(shellFor("bat", true), /cmd(\.exe)?$/i);
  assert.match(shellFor("cmd.exe", true), /cmd(\.exe)?$/i);
  assert.match(shellFor("{.cmd}", true), /cmd(\.exe)?$/i);
  assert.match(shellFor("powershell", true), /powershell\.exe$/i);
  assert.match(shellFor("ps1", true), /powershell\.exe$/i);
  assert.match(shellFor("powershell.exe", true), /powershell\.exe$/i);
  // A PowerShell block is PowerShell even when the tag mentions Windows.
  assert.match(shellFor("windows powershell", true), /powershell\.exe$/i);
});

test("names the blocks it did not run", () => {
  assert.deepEqual(unrunTags("Here is the JSON:\n\n```json\n{}\n```"), ["json"]);
  assert.deepEqual(unrunTags("```text\nshown\n```"), ["text"]);
  assert.deepEqual(unrunTags("```cmd\ndir\n```"), [], "a command is not a skipped block");
  assert.deepEqual(unrunTags("Just prose."), []);
});

test("leaves a bash block to the default shell on Windows", () => {
  assert.equal(shellFor("bash", true), undefined);
  assert.equal(shellFor("", true), undefined);
});

test("has only one shell to choose between off Windows", () => {
  for (const tag of ["bash", "cmd", "powershell"]) assert.equal(shellFor(tag, false), undefined, tag);
});

test("never mistakes the WSL launcher for a usable shell", () => {
  assert.equal(isWslStub("C:\\Windows\\System32\\bash.exe"), true);
  assert.equal(isWslStub("C:\\Windows\\SysWOW64\\bash.exe"), true);
  assert.equal(isWslStub("C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe"), true);
  assert.equal(isWslStub("C:/Program Files/Git/bin/bash.exe"), false);
  assert.equal(isWslStub("C:\\msys64\\usr\\bin\\bash.exe"), false);
});

test("picks a shell that can actually run a command", () => {
  const shell = resolveShell();
  assert.ok(shell.length > 0);
  assert.equal(isWslStub(shell), false, `resolved shell must be usable, got ${shell}`);
});

test("drops a Windows prompt copied into the block", () => {
  assert.equal(commandIn("```cmd\nC:\\Users\\Aaron>dir\n```"), "dir");
  assert.equal(commandIn("```powershell\nPS C:\\Users\\Aaron>Get-Date\n```"), "Get-Date");
});

test("leaves a command that only starts like a path alone", () => {
  const exe = "C:\\Windows\\System32\\cmd.exe /c dir";
  assert.equal(commandIn(`\`\`\`cmd\n${exe}\n\`\`\``), exe);
});

test("survives CRLF line endings", () => {
  assert.equal(commandIn("Sure.\r\n\r\n```bash\r\ndate\r\n```\r\n"), "date");
  assert.equal(commandIn("```cmd\r\ncd /d C:\\Users\r\ndir\r\n```"), "cd /d C:\\Users\ndir");
});

test("still ignores a block that is not a command", () => {
  for (const tag of ["ini", "json", "text", "python", "yaml", "output", "diff"]) {
    assert.equal(commandIn(`\`\`\`${tag}\n[section]\nkey=1\n\`\`\``), "", tag);
  }
});

/* ------------------------------------------------------------------ */
console.log("\n== what the model is told, with the command taken out ==\n");
/* ------------------------------------------------------------------ */

test("drops the block from the prose", () => {
  const reply = "Let me check the date.\n\n```bash\ndate\n```";
  assert.equal(proseOf(reply), "Let me check the date.");
});

test("keeps prose on both sides of the block", () => {
  const reply = "First this.\n\n```bash\ndate\n```\n\nThen we know.";
  assert.equal(proseOf(reply), "First this.\n\nThen we know.");
});

test("keeps the model's own output blocks in the prose", () => {
  const reply = "It should print:\n\n```text\nhello\n```";
  assert.match(proseOf(reply), /hello/);
});

/* ------------------------------------------------------------------ */
console.log("\n== what gets typed back ==\n");
/* ------------------------------------------------------------------ */

test("is the output, and nothing else", () => {
  assert.equal(paste({ exitCode: 0, stdout: "total 8\n", stderr: "" }), "total 8");
});

test("says so when there was nothing to show", () => {
  assert.equal(paste({ exitCode: 0, stdout: "", stderr: "" }), "(no output)");
});

test("keeps stderr", () => {
  assert.equal(paste({ exitCode: 1, stdout: "", stderr: "ls: cannot access 'x'" }), "ls: cannot access 'x'\n(exit code 1)");
});

test("reports a non-zero exit code", () => {
  assert.equal(paste({ exitCode: 2, stdout: "some output", stderr: "" }), "some output\n(exit code 2)");
});

test("says nothing about a successful exit", () => {
  assert.doesNotMatch(paste({ exitCode: 0, stdout: "fine", stderr: "" }), /exit/);
});

test("puts stdout before stderr", () => {
  assert.equal(paste({ exitCode: 3, stdout: "out", stderr: "err" }), "out\nerr\n(exit code 3)");
});

test("does not echo the command back", () => {
  const typed = paste({ exitCode: 0, stdout: "/usr/bin", stderr: "" });
  assert.doesNotMatch(typed, /pwd/);
});

/* ------------------------------------------------------------------ */
console.log("\n== what the model said, and what it only thought ==\n");
/* ------------------------------------------------------------------ */

// A message is a list of typed fragments - THINK for the thinking, RESPONSE for
// the reply - and the site names the type once, then streams the rest of that
// fragment as appends that name nothing at all. The appends use the *same*
// field for both channels, so the channel has to be carried, never re-derived
// from the chunk in front of you. Getting that wrong is the model's private
// thoughts shown to the user as its reply, and a fenced command inside them run.
const stream = (...chunks) => `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n")}\n`;

/** The site's own way of appending to the fragment being streamed. */
const append = (body) => ({ p: "response/fragments/-1/content", o: "APPEND", v: body });

const thinking = (content) => ({ p: "response/fragments", o: "APPEND", v: [{ id: 1, type: "THINK", content }] });
const answering = (content) => ({ p: "response/fragments", o: "APPEND", v: [{ id: 2, type: "RESPONSE", content }] });

test("reads the answer and leaves the reasoning out", () => {
  const raw = stream(
    thinking("Thinking. "),
    append("A command I am only thinking about:\n\n```bash\ntouch nope.txt\n```"),
    answering("Sure. "),
    append("Here you go.\n\n```bash\ndate\n```"),
    { p: "response/status", v: "FINISHED" },
  );
  assert.equal(parseStream(raw).text, "Sure. Here you go.\n\n```bash\ndate\n```");
});

// The appends that follow a fragment carry no type, so they belong to it.
// These are what a client that re-reads the channel per chunk gets wrong, and
// they are where most of the reasoning actually arrives.
test("an append belongs to the fragment it follows", () => {
  const raw = stream(thinking("only thinking"), append(" and more of it"), { v: " and more" });
  assert.equal(parseStream(raw).text, "");
});

test("the same append is the answer when the answer came first", () => {
  const raw = stream(answering("the answer"), append(" continues"), { v: " and continues" });
  assert.equal(parseStream(raw).text, "the answer continues and continues");
});

test("switches channel when the answer starts mid-stream", () => {
  const raw = stream(thinking("hmm"), append(" still hmm"), answering("the answer"), append(" continues"));
  assert.equal(parseStream(raw).text, "the answer continues");
});

// Before anything has said it is the answer, it is the thinking - so a stream
// that opens with an append cannot leak one.
test("an append before any fragment is not the answer", () => {
  const raw = stream(append("reasoning with no fragment named yet"), answering("the answer"));
  assert.equal(parseStream(raw).text, "the answer");
});

test("knows the reasoning by every name it goes by", () => {
  for (const type of ["THINK", "thinking", "REASONING", "cot", "SEARCH", "SEARCH_REF"]) {
    const raw = stream(
      { p: "response/fragments", v: [{ type, content: "NOT the answer" }] },
      append(" still not the answer"),
    );
    assert.equal(parseStream(raw).text, "", type);
  }
});

// A type we have never seen carries nothing at all, and does not move the
// channel either. Losing the answer is visible; showing the thinking is not.
test("an unknown fragment type carries no text", () => {
  const raw = stream(
    { p: "response/fragments", v: [{ type: "SOMETHING_NEW", content: "not shown" }] },
    append(" nowhere"),
    answering("the answer"),
  );
  assert.equal(parseStream(raw).text, "the answer");
});

test("a fragment with no type carries no text", () => {
  const raw = stream(
    { p: "response/fragments", v: [{ id: 1, content: "not shown" }] },
    append(" nowhere"),
  );
  assert.equal(parseStream(raw).text, "");
});

test("reads the answer whatever name the answer goes by", () => {
  for (const type of ["RESPONSE", "text", "TEXT", "answer"]) {
    const raw = stream({ p: "response/fragments", v: [{ type, content: "the answer" }] });
    assert.equal(parseStream(raw).text, "the answer", type);
  }
});

test("knows the reasoning by a field name too", () => {
  for (const field of ["response/thinking_content", "response/reasoning", "response/cot"]) {
    const raw = stream({ p: field, v: "NOT the answer" }, append(" still not"));
    assert.equal(parseStream(raw).text, "", field);
  }
});

// A status word is not text, and must not end the fragment either - or the rest
// of the answer is thrown away.
test("keeps reading the answer when a status interrupts it", () => {
  const raw = stream(
    { p: "response/status", v: "WIP" },
    { p: "response/content", v: "Hello" },
    { p: "response/status", v: "FINISHED" },
    append(" world"),
  );
  assert.equal(parseStream(raw).text, "Hello world");
});

test("a status word is never text", () => {
  const raw = stream(answering("Hello"), { p: "response/status", v: "FINISHED" });
  assert.equal(parseStream(raw).text, "Hello");
});

test("reads a whole-response snapshot", () => {
  const raw = stream({
    v: {
      response: {
        fragments: [{ type: "THINK", content: "hidden" }, { type: "RESPONSE", content: "the answer" }],
      },
    },
  });
  assert.equal(parseStream(raw).text, "the answer");
});

test("still reads the older plain-text stream", () => {
  const raw = stream(
    { p: "response/content", v: "Hello" },
    append(" world"),
    { p: "response/status", v: "FINISHED" },
  );
  assert.equal(parseStream(raw).text, "Hello world");
});

/* ------------------------------------------------------------------ */
console.log("\n== the loop ==\n");
/* ------------------------------------------------------------------ */

/** A stand-in for the browser: hands back scripted replies, records prompts. */
function fakeChat(replies) {
  const sent = [];
  let index = 0;
  const chat = {
    login: "stub",
    mode: "stub",
    sent,
    async ask(prompt) {
      sent.push(prompt);
      const reply = replies[index++];
      if (reply === undefined) throw new Error(`stub ran out of replies after ${sent.length} turns`);
      return { text: typeof reply === "function" ? await reply(prompt) : reply };
    },
    currentChatId: () => "chat-1",
    async newSession() {},
    async openSession() {},
    async close() {},
    async listSessions() {
      return [];
    },
  };
  return chat;
}

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), "anyagent-test-"));

// A command that never finishes must be reported, not hung on.
await testAsync("stops a command that never finishes", async () => {
  const chat = fakeChat(["```bash\nsleep 30\n```", "It was stopped."]);
  await new Agent(chat, CWD).run("wait forever");
  assert.match(chat.sent[1], /stopped after/);
});

await testAsync("runs the command, pastes the output, and stops on a reply with no block", async () => {
  const chat = fakeChat([
    "The date is what we want.\n\n```bash\necho hello-from-the-shell\n```",
    "It printed hello-from-the-shell. Done.",
  ]);
  const agent = new Agent(chat, CWD);
  const answer = await agent.run("say hello");

  assert.equal(answer, "It printed hello-from-the-shell. Done.");
  assert.equal(chat.sent.length, 2);
  assert.equal(chat.sent[1], "hello-from-the-shell");
});

await testAsync("says the setup once, as part of the first message", async () => {
  const chat = fakeChat(["All done.", "Second reply."]);
  const agent = new Agent(chat, CWD);
  await agent.run("first task");
  await agent.run("second task");

  assert.match(chat.sent[0], /first task/);
  assert.match(chat.sent[0], new RegExp(CWD));
  assert.equal(chat.sent[1], "second task", "later tasks in the same chat stand on their own");
});

await testAsync("does not repeat the setup when a chat is resumed", async () => {
  const chat = fakeChat(["Continuing."]);
  const agent = new Agent(chat, CWD);
  await agent.openSession("chat-1");
  await agent.run("what were we doing?");

  assert.equal(chat.sent[0], "what were we doing?");
});

await testAsync("says the setup again after /new", async () => {
  const chat = fakeChat(["One.", "Two."]);
  const agent = new Agent(chat, CWD);
  await agent.run("first");
  await agent.newSession();
  await agent.run("second");

  assert.match(chat.sent[1], /second/);
  assert.match(chat.sent[1], new RegExp(CWD), "a new chat needs the setup again");
});

await testAsync("sends the failure back so the model can react to it", async () => {
  const chat = fakeChat([
    "```bash\nexit 7\n```",
    "That failed, let me look elsewhere.",
  ]);
  const agent = new Agent(chat, CWD);
  await agent.run("break something");

  assert.equal(chat.sent[1], "(exit code 7)");
});

await testAsync("sends stderr back too", async () => {
  const chat = fakeChat(["```bash\nls /definitely-not-here\n```", "Not found."]);
  await new Agent(chat, CWD).run("look for it");
  assert.match(chat.sent[1], /No such file or directory/);
});

await testAsync("keeps a multi-line block in one shell, so cd sticks", async () => {
  const chat = fakeChat(["```bash\ncd /tmp\npwd\n```", "You are in /tmp."]);
  await new Agent(chat, CWD).run("where am I");
  assert.equal(chat.sent[1], "/tmp");
});

await testAsync("runs a block the model fenced for Windows instead of skipping it", async () => {
  for (const tag of ["cmd", "cmd.exe", "powershell", "windows powershell"]) {
    const chat = fakeChat([`\`\`\`${tag}\necho windows-style\n\`\`\``, "Done."]);
    const answer = await new Agent(chat, CWD).run("say it");
    assert.equal(chat.sent.length, 2, `${tag}: the block must reach the shell, not the prose`);
    assert.match(chat.sent[1], /windows-style/, tag);
    assert.equal(answer, "Done.", tag);
  }
});

await testAsync("says which blocks it did not run when the reply ends the task", async () => {
  const chat = fakeChat(['Done - the file looks like:\n\n```json\n{"a": 1}\n```']);
  const seen = [];
  await new Agent(chat, CWD).run("show me the file", { onUnrun: (tags) => seen.push(...tags) });
  assert.deepEqual(seen, ["json"]);
});

await testAsync("stays quiet when the closing reply holds no block", async () => {
  const chat = fakeChat(["All done."]);
  const seen = [];
  await new Agent(chat, CWD).run("do it", { onUnrun: (tags) => seen.push(...tags) });
  assert.deepEqual(seen, []);
});

await testAsync("runs a command in a shell named by the caller", async () => {
  const result = await runShell("echo explicit-shell", CWD, resolveShell());
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /explicit-shell/);
});

await testAsync("runs the command in the working directory", async () => {
  const chat = fakeChat(["```bash\npwd\n```", "Done."]);
  await new Agent(chat, CWD).run("where am I");
  assert.equal(chat.sent[1], CWD);
});

await testAsync("starts each block in a fresh shell", async () => {
  const chat = fakeChat(["```bash\ncd /tmp\n```", "```bash\npwd\n```", "Done."]);
  await new Agent(chat, CWD).run("go to /tmp");
  assert.equal(chat.sent[2], CWD, "a later block does not inherit an earlier cd");
});

await testAsync("catches a shell that never started", async () => {
  const chat = fakeChat(["```bash\nthis-command-does-not-exist-xyz --go\n```", "Right."]);
  await new Agent(chat, CWD).run("run it");
  assert.match(chat.sent[1], /command not found/);
});

await testAsync("reads a file for the model", async () => {
  const chat = fakeChat(["```bash\ncat /etc/hostname\n```", "Noted."]);
  await new Agent(chat, CWD).run("read the hostname");
  assert.ok(chat.sent[1].trim().length > 0);
  assert.doesNotMatch(chat.sent[1], /exit code/);
});

await testAsync("cannot loop forever", async () => {
  // A model that only ever sends commands never reaches a reply with no block.
  const long = fakeChat(new Array(20).fill("```bash\necho again\n```"));
  const answer = await new Agent(long, CWD).run("never finish");
  assert.equal(answer, "Agent stopped: maximum iterations reached.");
  assert.equal(long.sent.length, 6, "stops at DEEPSEEK_MAX_ITERATIONS, not before and not after");
});

await testAsync("asks again when the backend sends nothing back", async () => {
  const chat = fakeChat(["", "", "Here at last."]);
  const answer = await new Agent(chat, CWD).run("say something");
  assert.equal(answer, "Here at last.");
  assert.equal(chat.sent.length, 3);
});

await testAsync("gives up honestly when nothing ever comes back", async () => {
  const chat = fakeChat(["", "", "", ""]);
  await assert.rejects(
    () => new Agent(chat, CWD).run("say something"),
    /Nothing came back from DeepSeek 3 times in a row/,
  );
});

await testAsync("treats a reply with no shell block as the answer, and keeps it whole", async () => {
  const reply = 'Here it is:\n\n```json\n{"a": 1}\n```';
  const chat = fakeChat([reply]);
  const answer = await new Agent(chat, CWD).run("do something");
  assert.equal(answer, reply);
  assert.equal(chat.sent.length, 1, "nothing was run, so nothing is sent back");
});

await testAsync("does not run a block the model is only showing us", async () => {
  const chat = fakeChat(["The output will look like:\n\n```text\nhello world\n```", "Anything else?"]);
  const answer = await new Agent(chat, CWD).run("what will it print");
  assert.match(answer, /hello world/);
  assert.match(chat.sent[0], /what will it print/);
  assert.equal(chat.sent.length, 1);
});

await testAsync("says when a big output was cut short", async () => {
  const chat = fakeChat(["```bash\nhead -c 60000 /dev/zero | tr '\\0' 'x'\n```", "That is a lot."]);
  await new Agent(chat, CWD).run("print a lot");
  assert.match(chat.sent[1], /\.\.\. \[truncated \d+ chars\]/);
  assert.ok(chat.sent[1].length < 40_000, "the paste must stay bounded");
});

await testAsync("reports the events as they happen", async () => {
  const chat = fakeChat(["Let me look.\n\n```bash\necho observed\n```", "Done."]);
  const seen = { replies: [], commands: [], results: [] };
  await new Agent(chat, CWD).run("observe", {
    onReply: (prose) => seen.replies.push(prose),
    onCommand: (command) => seen.commands.push(command),
    onResult: (result) => seen.results.push(result),
  });

  // Only the working turns are announced; the final reply is the answer itself.
  assert.deepEqual(seen.replies, ["Let me look."]);
  assert.deepEqual(seen.commands, ["echo observed"]);
  assert.equal(seen.results[0].stdout.trim(), "observed");
});

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`FAILED: ${failure.name}\n${failure.error.stack}\n`);
  process.exit(1);
}
