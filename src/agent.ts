/**
 * The agent loop. The entire heart of the application lives here:
 *
 *   user task → DeepSeek → tool calls? → execute tools → back to DeepSeek
 *                          → no → return final answer
 */

import { ModelError, type ChatMessage, type Model, type ToolDefinition } from "./model.js";
import type { Tool } from "./tools.js";

export const SYSTEM_PROMPT = `You are a command-line AI agent powered by DeepSeek. You work on the user's computer through one tool: shell — run any command in the working directory; you get back exitCode, stdout, stderr.

Use shell to inspect the system, create and edit files, install and run programs, and verify results. Always actually do the work — never just explain how.

To call the tool, output ONLY this JSON and nothing else:
{"tool_calls":[{"id":"1","type":"function","function":{"name":"shell","arguments":{"command":"ls -la"}}}]}

RULES:
- Work step by step: run a command, read its output, then decide the next command.
- Never claim something worked unless the tool result confirmed it. If a command fails, inspect the error and try another approach.
- When the task is complete, reply with a short final answer as plain text.`;

const TOOL_USAGE_INSTRUCTIONS = `Do real work with your shell tool. Whenever an action is needed, output ONLY this JSON (nothing else):
{"tool_calls":[{"id":"1","type":"function","function":{"name":"shell","arguments":{"command":"COMMAND"}}}]}
Tool results come back as {"exitCode":...,"stdout":...,"stderr":...}. Read them, then continue or finish.`;

const MAX_UNPARSEABLE_TOOL_CALL_RETRIES = 3;

const UNPARSEABLE_TOOL_CALL_NUDGE = `Your previous message was a tool-call JSON block that could not be parsed. Do not explain it or apologize — just re-send the tool call as valid JSON on a single line, in exactly this shape:
{"tool_calls":[{"id":"1","type":"function","function":{"name":"shell","arguments":{"command":"COMMAND"}}}]}
Escape only double quotes and backslashes. Never escape any other character (no \\$, no \\', no \\. ).`;

/**
 * True when a "final answer" is really a tool-call block the parser could not
 * read. Showing that raw JSON to the user is never useful: it means the model
 * asked for an action that never ran.
 */
function looksLikeUnparsedToolCall(text: string): boolean {
  return /"tool_calls"\s*:/.test(text) && /"function"\s*:/.test(text);
}

export type AgentOptions = {
  model: Model;
  tools: Record<string, Tool>;
  cwd?: string;
  maxIterations?: number;
  /** Initial conversation, used to resume a saved session. */
  messages?: ChatMessage[];
  /** Called before a tool executes. `args` is undefined when arguments failed to parse. */
  onToolCallStart?: (name: string, args?: Record<string, unknown>) => void;
  /**
   * Called after a tool execution attempt. `result` is the tool's own
   * result (or the error object) so the caller can report what actually
   * happened — e.g. a timed-out command is not a success.
   */
  onToolCallFinish?: (name: string, ok: boolean, result?: unknown) => void;
};

/** Strip the resume marker from assistant text before returning to the user. */
function stripResumeMarker(text: string): string {
  if (!text) return text;
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) return text;
  const candidate = text.slice(lastNewline + 1).trim();
  // The marker is a JSON object with chat_session_id and message_id fields.
  if (candidate.startsWith("{") && candidate.endsWith("}")) {
    try {
      const parsed = JSON.parse(candidate);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.chat_session_id === "string" &&
        typeof (parsed.message_id ?? parsed.messageId) === "string"
      ) {
        return text.slice(0, lastNewline).trimEnd();
      }
    } catch {
      // not a marker
    }
  }
  return text;
}

/** Parse OpenAI tool_call.function.arguments (a JSON string, or already an object). */
function parseToolArguments(raw: unknown): Record<string, unknown> | null {
  if (raw == null || raw === "") return {};
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export class Agent {
  private messages: ChatMessage[];
  private readonly model: Model;
  private readonly tools: Record<string, Tool>;
  private readonly cwd: string;
  private readonly maxIterations: number;
  private readonly onToolCallStart?: (name: string, args?: Record<string, unknown>) => void;
  private readonly onToolCallFinish?: (name: string, ok: boolean, result?: unknown) => void;

  constructor(options: AgentOptions) {
    this.model = options.model;
    this.tools = options.tools;
    this.cwd = options.cwd ?? process.cwd();
    this.maxIterations = options.maxIterations ?? 50;
    this.onToolCallStart = options.onToolCallStart;
    this.onToolCallFinish = options.onToolCallFinish;
    this.messages = (options.messages ?? []).map((m) => ({ ...m }));
  }

  /** Forget the current conversation (used by /clear). */
  reset(): void {
    this.messages = [];
  }

  /** Current conversation, for persisting to a session file. */
  snapshot(): ChatMessage[] {
    return this.messages.map((m) => ({ ...m }));
  }

  /**
   * Ask the model, retrying once on transient failures (network hiccups,
   * pow refreshes). The conversation is only mutated after a successful
   * chat, so retrying with the same messages is safe. Session problems are
   * not transient and are rethrown immediately.
   */
  private async chatWithRetry(definitions: ToolDefinition[]): Promise<ChatMessage> {
    try {
      return await this.model.chat(this.messages, definitions);
    } catch (error) {
      if (error instanceof ModelError && error.kind === "invalid-session") {
        throw error;
      }
      // One retry after a short pause; if it fails again, surface it.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return await this.model.chat(this.messages, definitions);
    }
  }

  /**
   * Run one user task. In interactive mode callers reuse the same Agent so
   * the conversation is preserved across tasks.
   */
  async run(task: string): Promise<string> {
    if (typeof task !== "string" || task.trim() === "") {
      throw new Error("Task must be a non-empty string.");
    }

    if (this.messages.length === 0) {
      this.messages.push({ role: "system", content: SYSTEM_PROMPT });
    }

    // On the first turn prepend full tool instructions; on later turns add
    // a one-line reminder — the model sometimes forgets to use tools.
    const isFirstTurn = this.messages.length === 1;
    let userContent = task;
    if (isFirstTurn) {
      userContent = TOOL_USAGE_INSTRUCTIONS + "\n\n" + task;
    } else {
      userContent =
        "Do real work with your shell tool: output the {\"tool_calls\":[...]} JSON when an action is needed.\n\n" +
        task;
    }
    this.messages.push({ role: "user", content: userContent });

    const definitions = Object.values(this.tools).map((tool) => tool.definition);

    let unparseableAttempts = 0;

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      const assistant = await this.chatWithRetry(definitions);

      const toolCalls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
      if (toolCalls.length === 0) {
        // Final answer.
        const text = typeof assistant.content === "string" ? assistant.content : "";
        const display = stripResumeMarker(text).trim();
        if (display === "") {
          // The model returned empty — nudge it to give a final answer.
          this.messages.push({ role: "assistant", content: text });
          this.messages.push({ role: "user", content: "Please provide your final answer now." });
          continue;
        }
        // Never surface an unparsed tool-call block as the final answer: it
        // means the model wanted an action that never ran. Ask it to re-send
        // the call, a bounded number of times, then fail honestly.
        if (looksLikeUnparsedToolCall(display)) {
          unparseableAttempts++;
          if (unparseableAttempts <= MAX_UNPARSEABLE_TOOL_CALL_RETRIES) {
            this.messages.push({ role: "assistant", content: text });
            this.messages.push({ role: "user", content: UNPARSEABLE_TOOL_CALL_NUDGE });
            continue;
          }
          return (
            "Agent stopped: the model returned malformed tool-call JSON " +
            `${MAX_UNPARSEABLE_TOOL_CALL_RETRIES} times and it could not be parsed.`
          );
        }
        this.messages.push({ role: "assistant", content: text });
        return display;
      }

      // Preserve the assistant message with its tool_calls, then execute
      // each call and append its result.
      this.messages.push({
        role: "assistant",
        content: assistant.content ?? null,
        tool_calls: toolCalls,
      });

      for (const rawCall of toolCalls) {
        const call = rawCall as {
          id?: unknown;
          function?: { name?: unknown; arguments?: unknown };
        };
        const name = typeof call.function?.name === "string" ? call.function.name : "";
        const callId = typeof call.id === "string" ? call.id : "";

        let result: unknown = {
          error: true,
          message: "Tool call is missing a function name.",
        };
        let ok = false;

        if (name !== "") {
          let args: Record<string, unknown> | null = null;
          try {
            args = parseToolArguments(call.function?.arguments);
          } catch {
            args = null;
          }
          this.onToolCallStart?.(name, args ?? undefined);

          if (args === null) {
            result = {
              error: true,
              message: `Invalid JSON arguments for tool "${name}".`,
            };
          } else if (!this.tools[name]) {
            result = { error: true, message: `Unknown tool: ${name}` };
          } else {
            try {
              result = await this.tools[name].execute(args, { cwd: this.cwd });
              ok = true;
            } catch (error) {
              // A tool failure must never crash the agent: report it back
              // to the model so it can decide what to do next.
              result = {
                error: true,
                message: error instanceof Error ? error.message : String(error),
              };
            }
          }
        } else {
          this.onToolCallStart?.(name);
        }

        this.onToolCallFinish?.(name, ok, result);
        this.messages.push({
          role: "tool",
          tool_call_id: callId,
          content: JSON.stringify(result),
        });
      }
    }

    return "Agent stopped: maximum iterations reached.";
  }
}