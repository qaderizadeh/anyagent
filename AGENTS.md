# AGENTS.md — AnyAgent

> **Implementation status (read first):** this file is the original design spec.
> The shipped implementation has deliberately moved past it: the backend is now
> **chat.deepseek.com directly** (no FreeDeepseekAPI server, no API key — see
> `src/deepseek.ts`), and the tool surface is a **single `shell` tool** (no
> `read_file`/`write_file`, no `tunnel`). The agent loop, iteration cap, tool-error
> handling, and session persistence described below still hold. Branding is
> **AnyAgent** (`anyagent` CLI, `~/.anyagent/sessions`), by anydev.ir.

## Project Goal

Build the smallest practical CLI AI agent on top of:

https://github.com/ForgetMeAI/FreeDeepseekAPI

The agent must use the local FreeDeepseekAPI server as its model backend and implement only the minimum runtime required to turn DeepSeek into a tool-using agent.

Do NOT build a general-purpose agent framework.

Do NOT add LangChain, LangGraph, MCP, vector databases, embeddings, RAG, memory databases, web frameworks, or other unnecessary abstractions.

The project should remain small, understandable, and easy to modify.

---

# 1. Core Concept

The agent is simply this loop:

```text
User task
    ↓
DeepSeek
    ↓
Final response? ── yes ──→ print response and exit
    │
    no
    ↓
Tool call
    ↓
Execute tool
    ↓
Tool result
    ↓
DeepSeek
    ↓
repeat
```

The agent itself should contain very little logic.

Conceptually:

```ts
while (true) {
    const response = await callModel(messages);

    if (response is final) {
        print(response);
        break;
    }

    if (response contains tool calls) {
        for (const toolCall of response.toolCalls) {
            const result = await executeTool(toolCall);
            addToolResultToMessages(result);
        }

        continue;
    }
}
```

That is the heart of the application.

---

# 2. Backend

FreeDeepseekAPI runs locally and exposes an OpenAI-compatible API.

Default base URL:

```text
http://127.0.0.1:9655/v1
```

Primary endpoint:

```text
POST /v1/chat/completions
```

The current FreeDeepseekAPI project supports OpenAI-compatible chat completions and tool calling.

Use the API directly.

Do not implement browser automation or DeepSeek Web communication inside this project.

FreeDeepseekAPI is responsible for communicating with DeepSeek.

The agent is responsible only for:

* conversation state
* tool definitions
* tool execution
* looping
* CLI interaction
* stopping

---

# 3. Technology

Use:

* Node.js
* TypeScript
* npm
* native `fetch`

Prefer zero runtime dependencies where practical.

Do NOT introduce the OpenAI npm SDK unless there is a strong technical reason.

The FreeDeepseekAPI endpoint is simple enough to call using native `fetch`.

Target:

```text
Node.js 20+
```

---

# 4. Project Structure

Keep the project tiny.

Preferred structure:

```text
src/
├── agent.ts
├── model.ts
├── tools.ts
└── cli.ts

package.json
tsconfig.json
AGENTS.md
README.md
```

Avoid creating additional files unless necessary.

---

# 5. Model Client

Create a very small model client.

Example conceptual API:

```ts
type ChatMessage = {
    role: string;
    content?: string | null;
    tool_calls?: unknown[];
    tool_call_id?: string;
};

type ToolDefinition = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: object;
    };
};

class Model {
    constructor(
        private baseUrl = "http://127.0.0.1:9655/v1",
        private model = "deepseek-chat",
    ) {}

    async chat(
        messages: ChatMessage[],
        tools: ToolDefinition[],
    ) {
        // POST /chat/completions
    }
}
```

Do not make this class complicated.

The model client should only:

1. construct the request
2. send it
3. parse the response
4. return the relevant assistant message

---

# 6. Configuration

Support environment variables:

```text
FREEDEEPSEEK_URL
FREEDEEPSEEK_MODEL
FREEDEEPSEEK_API_KEY
```

Defaults:

```text
FREEDEEPSEEK_URL=http://127.0.0.1:9655/v1
FREEDEEPSEEK_MODEL=deepseek-chat
```

If `FREEDEEPSEEK_API_KEY` is not set, do not send an Authorization header.

This is important because a default local FreeDeepseekAPI installation does not require a proxy API key.

If the user configures `PROXY_API_KEY` on FreeDeepseekAPI, the CLI should support it.

---

# 7. Agent

Create an `Agent` class.

Minimal conceptual interface:

```ts
class Agent {
    async run(task: string): Promise<string>;
}
```

The agent owns the conversation:

```ts
const messages = [
    {
        role: "system",
        content: SYSTEM_PROMPT,
    },
    {
        role: "user",
        content: task,
    },
];
```

Then repeatedly call the model.

---

# 8. System Prompt

Use a short system prompt.

Do not create a giant prompt.

Initial version:

```text
You are a command-line AI agent.

You solve the user's task by reasoning and using the available tools when necessary.

Use tools when they help you inspect or modify the environment.

After completing the task, respond with a concise final answer.

Do not claim that you performed an action unless the corresponding tool actually succeeded.

If a tool fails, inspect the error and try another approach when appropriate.
```

The system prompt should not describe implementation details that the model can already see through tool definitions.

---

# 9. Tools

Start with only three tools:

```text
shell
read_file
write_file
```

Do not implement dozens of tools initially.

The goal is to prove that the agent loop works.

---

# 10. Shell Tool

Tool name:

```text
shell
```

Arguments:

```json
{
    "command": "string"
}
```

Description:

```text
Execute a shell command in the agent's working directory and return stdout, stderr, and exit code.
```

The implementation may use Node's `child_process`.

Prefer:

```ts
execFile
```

or:

```ts
spawn
```

instead of constructing a shell command from multiple untrusted arguments.

However, because the model is intentionally allowed to operate as a CLI coding agent, the initial implementation may execute the supplied command through the user's configured shell.

The working directory must be configurable.

Default:

```text
process.cwd()
```

Return structured results:

```json
{
    "exitCode": 0,
    "stdout": "...",
    "stderr": "..."
}
```

Never hide stderr.

---

# 11. Read File Tool

Tool name:

```text
read_file
```

Arguments:

```json
{
    "path": "string"
}
```

Return:

```json
{
    "path": "string",
    "content": "string"
}
```

Resolve relative paths from the agent working directory.

Do not silently access arbitrary paths outside the working directory unless explicitly configured.

---

# 12. Write File Tool

Tool name:

```text
write_file
```

Arguments:

```json
{
    "path": "string",
    "content": "string"
}
```

Create parent directories when necessary.

Return:

```json
{
    "path": "string",
    "written": true
}
```

Again, relative paths should resolve from the agent working directory.

---

# 13. Tool Registry

Keep tool registration extremely simple.

Example:

```ts
const tools = {
    shell: shellTool,
    read_file: readFileTool,
    write_file: writeFileTool,
};
```

Each tool should have:

```ts
{
    definition,
    execute
}
```

For example:

```ts
const shellTool = {
    definition: {
        type: "function",
        function: {
            name: "shell",
            description: "...",
            parameters: {
                type: "object",
                properties: {
                    command: {
                        type: "string"
                    }
                },
                required: ["command"]
            }
        }
    },

    async execute(args) {
        // ...
    }
};
```

The agent should not need special logic for individual tools.

It should simply:

```ts
const tool = tools[toolName];
const result = await tool.execute(args);
```

---

# 14. Tool Calling Loop

Use the OpenAI-compatible tool calling format exposed by FreeDeepseekAPI.

The important sequence is:

```text
messages
    ↓
POST /v1/chat/completions
    ↓
assistant message containing tool_calls
    ↓
execute each tool
    ↓
append assistant message
    ↓
append tool messages
    ↓
POST /v1/chat/completions again
```

For every tool call, preserve:

```text
tool_call.id
tool_call.function.name
tool_call.function.arguments
```

The tool result should reference the same:

```text
tool_call_id
```

Do not invent a different conversation format.

---

# 15. Multiple Tool Calls

The model may return multiple tool calls in one assistant response.

Support them.

Example:

```text
assistant
 ├── tool_call #1 → read_file
 ├── tool_call #2 → read_file
 └── tool_call #3 → shell
```

Execute each call and append each result.

Initially execute them sequentially for simplicity.

Do not add parallel execution unless it becomes necessary.

---

# 16. Maximum Iterations

The agent must never run indefinitely.

Default:

```text
MAX_ITERATIONS=50
```

Configuration:

```text
FREEDEEPSEEK_MAX_ITERATIONS
```

Example:

```ts
for (let iteration = 0; iteration < maxIterations; iteration++) {
    ...
}
```

If the limit is reached, stop and report:

```text
Agent stopped: maximum iterations reached.
```

---

# 17. Tool Errors

A tool failure must NOT crash the entire agent.

Instead, send the error back to DeepSeek as the tool result.

Example:

```json
{
    "error": true,
    "message": "File does not exist: ./foo.ts"
}
```

Then let the model decide what to do.

Example:

```text
Agent
  ↓
read_file(foo.ts)
  ↓
ERROR: file does not exist
  ↓
DeepSeek
  ↓
shell("find . -name '*.ts'")
  ↓
...
```

This is one of the most important properties of the agent loop.

---

# 18. CLI

The CLI should be interactive.

Example:

```text
$ anyagent

AnyAgent
Model: deepseek-chat
Backend: http://127.0.0.1:9655/v1

> create a simple node server in this directory
```

Then show tool activity:

```text
→ shell: ls -la
✓ shell

→ write_file: package.json
✓ write_file

→ write_file: index.js
✓ write_file

Done. Created the Node.js server.
```

The exact UI should remain simple.

Do not build a TUI framework.

Do not add React.

Do not add a web UI.

---

# 19. CLI Commands

The initial CLI only needs:

```text
anyagent
anyagent "task"
```

Interactive mode:

```text
anyagent
```

Single task:

```text
anyagent "create a hello world TypeScript project"
```

Optional commands:

```text
/help
/exit
/clear
```

Do not build a large command system.

---

# 20. Conversation

In interactive mode, preserve the conversation during the current process.

Example:

```text
> create a TypeScript project

Agent:
Done.

> now add eslint

Agent:
...
```

The second request must have access to the previous conversation.

Do not persist conversations to disk initially.

When the process exits, conversation may disappear.

---

# 21. DeepSeek Session

FreeDeepseekAPI itself supports agent/session identification through:

```text
x-agent-session
```

Use a stable session ID for the current agent process.

Example:

```text
x-agent-session: anyagent-cli
```

or generate a session ID at startup.

Do not rely on DeepSeek Web sessions as the agent's memory.

The agent should maintain its own `messages` array.

The FreeDeepseekAPI session is a backend concern.

---

# 22. Streaming

Streaming is optional for the first implementation.

Prioritize:

```text
stream: false
```

and get the agent loop working first.

Only add streaming after the basic agent is correct.

If streaming is later implemented, it should affect only presentation/model transport and should NOT change the agent architecture.

---

# 23. Reasoning Models

The agent should work with:

```text
deepseek-chat
```

first.

Do not special-case reasoning models in the agent.

If FreeDeepseekAPI returns:

```text
reasoning_content
```

the model adapter may preserve it if useful, but the agent loop should remain model-independent.

Do not attempt to expose or manipulate hidden reasoning.

---

# 24. Security

This is a local coding agent.

Shell execution is powerful.

Make this explicit in the CLI startup message:

```text
WARNING: this agent can execute shell commands and modify files.
Only run it in a directory/environment you trust.
```

Do not pretend shell execution is sandboxed unless it actually is.

Do not expose the CLI agent as a network service.

Do not add an HTTP server.

Do not bind anything to `0.0.0.0`.

---

# 25. Working Directory

Support:

```text
anyagent --cwd ./project
```

The agent should use that directory for:

* shell
* read_file
* write_file

The default is:

```text
process.cwd()
```

---

# 26. Do Not Overengineer

The following are explicitly OUT OF SCOPE:

* LangChain
* LangGraph
* MCP
* RAG
* vector databases
* embeddings
* autonomous background agents
* multi-agent systems
* planning frameworks
* task queues
* Redis
* SQLite
* PostgreSQL
* web dashboard
* Electron
* React
* authentication
* cloud deployment
* plugin marketplaces
* complex configuration systems
* persistent memory
* autonomous scheduling

Do not implement these unless explicitly requested later.

---

# 27. Error Handling

Handle at least:

```text
FreeDeepseekAPI unavailable
HTTP errors
invalid JSON response
missing assistant message
unknown tool
invalid tool arguments
tool execution failure
maximum iterations
Ctrl+C
```

If FreeDeepseekAPI is unavailable, show a useful message:

```text
Cannot connect to FreeDeepseekAPI.

Expected:
http://127.0.0.1:9655/v1

Start FreeDeepseekAPI first.
```

Do not print huge stack traces by default.

---

# 28. FreeDeepseekAPI Health Check

At startup, optionally check:

```text
GET http://127.0.0.1:9655/health
```

or:

```text
GET http://127.0.0.1:9655/v1/models
```

If unavailable, clearly tell the user.

Do not attempt to start FreeDeepseekAPI automatically.

AnyAgent and FreeDeepseekAPI should remain separate processes.

---

# 29. Implementation Order

Implement in this exact order.

## Step 1

Create the TypeScript project.

## Step 2

Implement the model client.

Test:

```text
"Say hello"
```

without tools.

## Step 3

Implement:

```text
read_file
```

## Step 4

Implement:

```text
write_file
```

## Step 5

Implement:

```text
shell
```

## Step 6

Implement the generic tool registry.

## Step 7

Implement the agent loop.

## Step 8

Implement interactive CLI.

## Step 9

Add maximum iteration protection.

## Step 10

Add graceful error handling.

Do not implement anything beyond this until the complete basic agent works.

---

# 30. Acceptance Test

The finished application must successfully handle:

```text
> create a file called hello.txt containing "Hello World"
```

Expected sequence:

```text
User
 ↓
DeepSeek
 ↓
write_file
 ↓
tool result
 ↓
DeepSeek
 ↓
final answer
```

Then:

```text
> read hello.txt
```

Expected:

```text
DeepSeek
 ↓
read_file
 ↓
tool result
 ↓
DeepSeek
 ↓
final answer
```

Then:

```text
> create a small JavaScript program and run it
```

Expected:

```text
DeepSeek
 ↓
write_file
 ↓
tool result
 ↓
shell
 ↓
tool result
 ↓
DeepSeek
 ↓
final answer
```

If these work, the agent is considered functional.

---

# 31. Philosophy

Keep the implementation boring.

The goal is NOT to create a sophisticated agent framework.

The goal is to prove that:

```text
DeepSeek
    +
tool definitions
    +
tool execution
    +
conversation loop
    =
useful AI agent
```

The entire agent should be understandable by reading `agent.ts`.

If the agent requires a framework to understand it, it is too complicated.

---

# 32. Final Desired API

The final internal API should be approximately:

```ts
const model = new Model({
    baseUrl: process.env.FREEDEEPSEEK_URL,
    model: process.env.FREEDEEPSEEK_MODEL,
});

const agent = new Agent({
    model,
    tools,
    maxIterations: 50,
    cwd: process.cwd(),
});

const result = await agent.run(task);

console.log(result);
```

The CLI should simply be a thin layer around this API.

---

# 33. Important Repository Rule

Before implementing the model adapter, inspect the current FreeDeepseekAPI repository and its current request/response format.

Do not assume an API shape from an old version.

The current repository is the source of truth.

In particular, verify:

* `/v1/chat/completions`
* tool calling request format
* tool calling response format
* model names
* authentication behavior
* session header behavior

Do not modify FreeDeepseekAPI unless absolutely necessary.

The AnyAgent agent should consume its existing API.

---

# 34. Definition of Done

The project is complete when:

1. `anyagent` starts an interactive CLI.
2. It connects to local FreeDeepseekAPI.
3. DeepSeek can answer normal questions.
4. DeepSeek can call `read_file`.
5. DeepSeek can call `write_file`.
6. DeepSeek can call `shell`.
7. Tool results are returned to DeepSeek.
8. DeepSeek can perform multiple tool calls in sequence.
9. DeepSeek eventually produces a final answer.
10. The agent stops after the final answer.
11. The agent cannot loop forever.
12. Tool failures are returned to the model.
13. No unnecessary framework is introduced.
14. The code remains small and easy to understand.

The implementation should favor simplicity over features.
