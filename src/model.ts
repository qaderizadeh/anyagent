/** Minimal DeepSeek web-chat client wrapper used by the agent.

 * The agent does not speak OpenAPI / Anthropic. It speaks the project's
 * own small chat shape (user text in, assistant text + optional tool
 * calls out) over the direct chat.deepseek.com backend.
 *
 * Session + proof-of-work are handled by src/deepseek.ts.
 */

import {
  createChatSession,
  lightHealthCheck,
  resolvePowWasmPath,
  runChat,
  type DeepseekSession,
} from "./deepseek.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCallList;
  tool_call_id?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ToolCallList = ToolCall[];

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
};

export type ModelOptions = {
  session: DeepseekSession;
  powWasmPath?: string;
  modelType?: string;
  thinkingEnabled?: boolean;
  searchEnabled?: boolean;
  timeoutMs?: number;
  chatSessionId?: string;
};

export class ModelError extends Error {
  readonly kind?: "invalid-session" | "backend-error" | "pow-error" | "parse-error" | "unknown";

  constructor(message: string, options: { kind?: ModelError["kind"]; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "ModelError";
    this.kind = options.kind;
  }
}

const DEFAULT_TIMEOUT_MS = 300_000;

function parseToolCalls(assistant: unknown): ToolCallList {
  if (!assistant || typeof assistant !== "object") return [];
  const obj = assistant as Record<string, unknown>;

  const raw = obj.tool_calls;
  if (!Array.isArray(raw)) return [];

  const calls: ToolCallList = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const call = item as Record<string, unknown>;
    const id = typeof call.id === "string" ? call.id : "";
    const fn = call.function;
    if (!fn || typeof fn !== "object") continue;
    const functionObj = fn as Record<string, unknown>;
    const name = typeof functionObj.name === "string" ? functionObj.name : "";
    let argumentsStr = "";
    if (functionObj.arguments != null) {
      argumentsStr =
        typeof functionObj.arguments === "string"
          ? functionObj.arguments
          : JSON.stringify(functionObj.arguments);
    }
    if (!name) continue;
    calls.push({ id, type: "function", function: { name, arguments: argumentsStr } });
  }
  return calls;
}

/**
 * Find the index just past the closing brace of the JSON object that
 * starts at `startIdx`, respecting quoted strings so braces inside file
 * contents don't confuse the matcher.
 */
function findJsonObjectEnd(text: string, startIdx: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Leniently repair common model-generated JSON mistakes so the block can
 * be parsed: escape literal control characters inside string values (the
 * model often emits real newlines/tabs in file contents) and drop trailing
 * commas before } or ].
 */
function repairJsonText(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === '"') { out += ch; inString = false; continue; }
      if (code === 10) { out += "\\n"; continue; }
      if (code === 13) { out += "\\r"; continue; }
      if (code === 9) { out += "\\t"; continue; }
      if (code < 32) {
        out += "\\u" + code.toString(16).padStart(4, "0");
        continue;
      }
      out += ch;
      continue;
    }
    out += ch;
    if (ch === '"') inString = true;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

/**
 * Look at the next significant token after `from` and decide whether it
 * starts a property (`"key":`) or an array element. Used to tell element
 * commas apart from property commas during rebalancing.
 */
function nextTokenKind(text: string, from: number): "property" | "element" | "end" {
  let i = from;
  let inString = false;
  let escaped = false;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') { inString = true; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === ":") return "property";
    return "element";
  }
  return "end";
}

/**
 * Rebalance a malformed JSON block by inserting missing closing braces /
 * brackets. The model's common failure is dropping the closing brace of one
 * or more objects inside the tool_calls array, which leaves elements open at
 * the comma separators. We close them by looking ahead: a comma followed by
 * a non-key token is an element separator, so any still-open object must be
 * closed before it. String values and property commas are preserved.
 */
function rebalanceJson(text: string): string {
  let out = "";
  const stack: string[] = []; // 'o' = object, 'a' = array
  let inString = false;
  let escaped = false;
  let prevToken = ""; // last significant structural token
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === "{") {
      // A new array element starts after '[' or ','. If the previous element
      // object is still open, the model dropped its closing brace — close it
      // before opening the new one.
      if ((prevToken === "[" || prevToken === ",") && stack[stack.length - 1] === "o") {
        out += "}";
        stack.pop();
      }
      stack.push("o");
      out += ch;
      prevToken = "{";
      continue;
    }
    if (ch === "[") { stack.push("a"); out += ch; prevToken = "["; continue; }
    if (ch === "}") {
      if (stack[stack.length - 1] === "o") { stack.pop(); out += ch; }
      // stray '}' with nothing to close: drop it
      prevToken = "}";
      continue;
    }
    if (ch === "]") {
      // Close any open objects first, then the array itself.
      while (stack.length > 0 && stack[stack.length - 1] === "o") {
        out += "}";
        stack.pop();
      }
      if (stack[stack.length - 1] === "a") { stack.pop(); out += ch; }
      // stray ']' with nothing to close: drop it
      prevToken = "]";
      continue;
    }
    if (ch === ":") { prevToken = ":"; out += ch; continue; }
    if (ch === ",") {
      // A comma inside an array separates elements; a comma inside an object
      // separates properties (followed by a key string + colon). When the
      // previous array element is still open (the model dropped its closing
      // brace), close it BEFORE the comma.
      if (nextTokenKind(text, i + 1) !== "property") {
        while (stack.length > 0 && stack[stack.length - 1] === "o") {
          out += "}";
          stack.pop();
        }
      }
      prevToken = ",";
      out += ch;
      continue;
    }
    out += ch;
  }
  // Close any contexts still open at the end of the text.
  while (stack.length > 0) {
    out += stack.pop() === "o" ? "}" : "]";
  }
  return out;
}

/**
 * Search for a {"tool_calls":[...]} JSON block embedded in assistant text.
 * The model may output it alone, preceded by explanation text, or wrapped
 * in ```json fences. Returns the parsed calls and the start index of the
 * JSON, or null.
 */
function extractToolCallsFromText(
  text: string,
): { calls: ToolCallList; startIdx: number } | null {
  const marker = '"tool_calls"';
  let searchFrom = 0;

  for (;;) {
    const markerIdx = text.indexOf(marker, searchFrom);
    if (markerIdx === -1) return null;

    // Walk back to the opening brace that contains the marker, skipping
    // whitespace. Handles ```json fences naturally. Note the block may
    // legitimately start at position 0 (the model sometimes outputs only
    // the JSON), so guard against start < 0 rather than start <= 0.
    let start = markerIdx;
    while (start > 0 && /\s/.test(text[start - 1])) start--;
    if (start === 0) {
      if (text[0] !== "{") {
        searchFrom = markerIdx + marker.length;
        continue;
      }
    } else if (text[start - 1] !== "{") {
      searchFrom = markerIdx + marker.length;
      continue;
    } else {
      start--;
    }

    const end = findJsonObjectEnd(text, start);
    // Unbalanced JSON (the model sometimes drops a closing brace) makes the
    // scanner unable to find a matching close. Fall back to the rest of the
    // text and let the rebalance repair pass fix it.
    const blockEnd = end === -1 ? text.length : end;
    const jsonStr = text.slice(start, blockEnd);
    // Try strict first, then progressively more lenient repairs:
    //   1. escape literal control characters inside string values
    //   2. also rebalance missing closing braces/brackets
    const attempts = [
      jsonStr,
      repairJsonText(jsonStr),
      rebalanceJson(repairJsonText(jsonStr)),
    ];
    for (const candidate of attempts) {
      try {
        const parsed = JSON.parse(candidate);
        const calls = parseToolCalls(parsed);
        if (calls.length > 0) return { calls, startIdx: start };
      } catch {
        // try the next candidate / occurrence
      }
    }
    searchFrom = markerIdx + marker.length;
  }
}

export class Model {
  readonly session: DeepseekSession;
  readonly powWasmPath: string;
  readonly modelType?: string;
  readonly thinkingEnabled: boolean;
  readonly searchEnabled: boolean;
  private readonly timeoutMs: number;
  private readonly chatSessionId?: string;

  constructor(options: ModelOptions) {
    this.session = options.session;
    this.modelType = options.modelType;
    this.thinkingEnabled = options.thinkingEnabled ?? true;
    this.searchEnabled = options.searchEnabled ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.chatSessionId = options.chatSessionId ?? undefined;
    this.powWasmPath = options.powWasmPath ?? resolvePowWasmPath();
  }

  /** Lightweight session verification used at startup. */
  async healthCheck(): Promise<void> {
    await lightHealthCheck(this.session);
  }

  /**
   * Send the current conversation and return the assistant message.
   */
  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
  ): Promise<ChatMessage> {
    let chatSessionId = this.chatSessionId ?? "";
    let parentMessageId = "";
    let usedExistingSession = false;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && msg.content != null) {
        const marker = extractResumeMarker(msg.content);
        if (marker) {
          chatSessionId = marker.chat_session_id;
          parentMessageId = marker.message_id;
          usedExistingSession = true;
        }
        break;
      }
    }

    if (!chatSessionId) {
      chatSessionId = await createChatSession(this.session);
      parentMessageId = "";
    } else if (!usedExistingSession && this.chatSessionId) {
      usedExistingSession = true;
    }

    const lastUserIdx = messages.reduce<number>((best, msg, idx) => {
      if (msg.role === "user" && idx > best) return idx;
      return best;
    }, -1);

    const userPrompt =
      lastUserIdx >= 0 ? messages[lastUserIdx].content : "";

    if (typeof userPrompt !== "string" || userPrompt.trim() === "") {
      throw new ModelError("No user prompt found in the current conversation.");
    }

    // Build the prompt to send. After tool results, include them so the
    // model can decide whether to continue calling tools or give a final
    // answer. We deliberately do NOT tell it to stop: multi-step tasks need
    // more tool calls after the first result. Iterations are bounded by the
    // agent's maxIterations instead.
    let promptToSend = userPrompt;
    const recentResults = messages
      .slice(lastUserIdx + 1)
      .filter((m) => m.role === "tool")
      .map((m) => (typeof m.content === "string" ? m.content : "{}"));
    if (recentResults.length > 0) {
      promptToSend =
        "Tool results:\n" +
        recentResults.join("\n") +
        "\n\nTask: " +
        userPrompt +
        "\n\nContinue working on the task. Use more tools if you need more " +
        "information or actions. When the task is fully complete, respond " +
        "with your final answer as plain text.";
    }

    const result = await runChat(
      this.session,
      {
        session: this.session,
        chat_session_id: chatSessionId,
        parent_message_id: parentMessageId || undefined,
        prompt: promptToSend,
        model_type: this.modelType,
        thinking_enabled: this.thinkingEnabled,
        search_enabled: this.searchEnabled,
      },
      this.powWasmPath,
    );

    const text = typeof result.text === "string" ? result.text : "";

    // The web API returns plain text. Tool calls may appear as a JSON object
    // {"tool_calls":[...]} somewhere in the response. Try to extract them.
    let toolCalls: ToolCallList = [];
    let cleanText = text;
    if (text) {
      const extracted = extractToolCallsFromText(text);
      if (extracted) {
        toolCalls = extracted.calls;
        cleanText = text.slice(0, extracted.startIdx).trimEnd();
      }
    }

    const out: ChatMessage = {
      role: "assistant",
      content: toolCalls.length > 0 ? "" : cleanText,
    };

    if (toolCalls.length > 0) {
      out.tool_calls = toolCalls;
    }

    if (result.message_id) {
      out.content = appendResumeMarker(out.content ?? "", {
        chat_session_id: chatSessionId,
        message_id: result.message_id,
      });
    }

    return out;
  }
}

function extractResumeMarker(content: string | null): { chat_session_id: string; message_id: string } | null {
  if (!content) return null;

  const tryParse = (candidate: string) => {
    try {
      const parsed = JSON.parse(candidate);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.chat_session_id === "string" &&
        (typeof parsed.message_id === "string" || typeof parsed.message_id === "number")
      ) {
        return parsed as { chat_session_id: string; message_id: string };
      }
    } catch {
      // not a marker
    }
    return null;
  };

  // Either the whole content is the marker, or the marker was appended on
  // the last line after a normal text answer.
  const direct = tryParse(content);
  if (direct) return direct;
  const lastNewline = content.lastIndexOf("\n");
  if (lastNewline !== -1) {
    return tryParse(content.slice(lastNewline + 1).trim());
  }
  return null;
}

function appendResumeMarker(
  content: string,
  marker: { chat_session_id: string; message_id: string },
): string {
  if (!content) return JSON.stringify(marker);
  try {
    const existing = JSON.parse(content);
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      return JSON.stringify({ ...existing, ...marker });
    }
  } catch {
    // leave existing text alone and append marker after it
  }
  return content + "\n" + JSON.stringify(marker);
}