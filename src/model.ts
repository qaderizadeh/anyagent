/** Minimal DeepSeek web-chat client wrapper used by the agent.

 * The agent does not speak OpenAPI / Anthropic. It speaks the project's
 * own small chat shape (user text in, assistant text + optional tool
 * calls out) over the direct chat.deepseek.com backend.
 *
 * Session + proof-of-work are handled by src/deepseek.ts.
 */

import {
  BIZ_CODE_INVALID_CHAT_SESSION,
  BIZ_CODE_INVALID_MESSAGE_ID,
  DeepseekClientError,
  createChatSession,
  lightHealthCheck,
  resolvePowWasmPath,
  runChat,
  type ChatResult,
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
  /** Called when the client has to make a non-obvious recovery decision
   *  (e.g. the DeepSeek session was lost and the conversation was replayed
   *  into a new one). The CLI surfaces this so it is never silent. */
  onNotice?: (message: string) => void;
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

/* ------------------------------------------------------------------ */
/* Prompt text                                                         */
/* ------------------------------------------------------------------ */

/** Local role definition. DeepSeek never sees this verbatim: the operative
 *  header is TOOL_USAGE_INSTRUCTIONS, sent at the start of a chat session. */
export const SYSTEM_PROMPT = `You are a command-line AI agent powered by DeepSeek. You work on the user's computer through one tool: shell — run any command in the working directory; you get back exitCode, stdout, stderr.

Use shell to inspect the system, create and edit files, install and run programs, and verify results. Always actually do the work — never just explain how.

To call the tool, output ONLY this JSON and nothing else:
{"tool_calls":[{"id":"1","type":"function","function":{"name":"shell","arguments":{"command":"ls -la"}}}]}

RULES:
- Work step by step: run a command, read its output, then decide the next command.
- Never claim something worked unless the tool result confirmed it. If a command fails, inspect the error and try another approach.
- When the task is complete, reply with a short final answer as plain text.`;

/** The tool rules the model actually reads. Sent at the start of every
 *  DeepSeek chat session (first turn, and whenever a session has to be
 *  re-seeded) so the agent never runs without its header. */
export const TOOL_USAGE_INSTRUCTIONS = `Do real work with your shell tool. Whenever an action is needed, output ONLY this JSON (nothing else):
{"tool_calls":[{"id":"1","type":"function","function":{"name":"shell","arguments":{"command":"COMMAND"}}}]}
Tool results come back as {"exitCode":...,"stdout":...,"stderr":...}. Read them, then continue or finish.`;

/** One-line reminder prepended to later turns of the same session. */
export const TOOL_REMINDER = `Do real work with your shell tool: output the {"tool_calls":[...]} JSON when an action is needed.`;

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
 * model often emits real newlines/tabs in file contents), fix invalid
 * escape sequences, and drop trailing commas before } or ].
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
      if (ch === "\\") {
        const next = text[i + 1];
        const simpleEscape =
          next === '"' || next === "\\" || next === "/" ||
          next === "b" || next === "f" || next === "n" ||
          next === "r" || next === "t";
        const unicodeEscape =
          next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6));
        if (simpleEscape || unicodeEscape) {
          out += ch;
          escaped = true;
          continue;
        }
        // Invalid JSON escape: the model mixed shell escaping into the JSON
        // string (e.g. \$ or \' ), which JSON.parse rejects. Preserve the
        // backslash as a literal character by escaping it, so the command
        // still reaches the shell exactly as the model intended.
        out += "\\\\";
        continue;
      }
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
export function extractToolCallsFromText(
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

/* ------------------------------------------------------------------ */
/* Context restoration                                                 */
/* ------------------------------------------------------------------ */

const SEED_MAX_ENTRIES = 12;
const SEED_ENTRY_CHARS = 500;
const SEED_TOOL_CHARS = 700;

function clipForContext(text: string, max: number): string {
  const one = text.replace(/\r/g, "").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}\u2026`;
}

/** Remove the per-turn instruction prefixes so a replayed user turn reads
 *  as the task the user actually typed. */
function stripPromptPrefixes(content: string): string {
  let out = content;
  for (const prefix of [TOOL_USAGE_INSTRUCTIONS, TOOL_REMINDER]) {
    if (out.startsWith(prefix)) out = out.slice(prefix.length);
  }
  return out.trim();
}

/** Assistant text without the hidden resume marker. */
function withoutResumeMarker(content: string): string {
  if (!content) return content;
  if (!extractResumeMarker(content)) return content;
  const lastNewline = content.lastIndexOf("\n");
  return lastNewline === -1 ? "" : content.slice(0, lastNewline).trimEnd();
}

function describeToolCalls(calls: ToolCallList): string[] {
  const lines: string[] = [];
  for (const call of calls) {
    let command = "";
    try {
      const args = JSON.parse(call.function.arguments || "{}") as { command?: unknown };
      if (typeof args?.command === "string") command = args.command;
    } catch {
      // keep the generic description
    }
    lines.push(
      command
        ? `used the shell tool: ${clipForContext(command, 300)}`
        : `called the ${call.function.name} tool`,
    );
  }
  return lines;
}

/**
 * Replay an earlier conversation into a prompt. Used when the DeepSeek chat
 * session behind a resumed conversation can no longer be continued: the new
 * session has no history, so without this the model would lose both its tool
 * rules and the work done so far.
 */
export function buildSessionSeed(
  priorMessages: ChatMessage[],
  currentPrompt: string,
): string {
  const entries: string[] = [];
  for (const msg of priorMessages) {
    if (msg.role === "system") continue;
    const content = typeof msg.content === "string" ? msg.content : "";

    if (msg.role === "user") {
      const text = stripPromptPrefixes(content);
      if (text) entries.push(`User: ${clipForContext(text, SEED_ENTRY_CHARS)}`);
      continue;
    }
    if (msg.role === "assistant") {
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        for (const line of describeToolCalls(msg.tool_calls)) {
          entries.push(`Assistant ${line}.`);
        }
      }
      const text = withoutResumeMarker(content).trim();
      if (text) entries.push(`Assistant: ${clipForContext(text, SEED_ENTRY_CHARS)}`);
      continue;
    }
    if (msg.role === "tool" && content) {
      entries.push(`Tool result: ${clipForContext(content, SEED_TOOL_CHARS)}`);
    }
  }

  return [
    TOOL_USAGE_INSTRUCTIONS,
    "",
    "You are continuing an existing session. Here is what happened earlier:",
    ...entries.slice(-SEED_MAX_ENTRIES),
    "",
    currentPrompt,
  ].join("\n");
}

export class Model {
  readonly session: DeepseekSession;
  readonly powWasmPath: string;
  readonly modelType?: string;
  readonly thinkingEnabled: boolean;
  readonly searchEnabled: boolean;
  private readonly timeoutMs: number;
  private readonly onNotice?: (message: string) => void;

  /**
   * The DeepSeek chat session this conversation is currently using, and the
   * last assistant message id we know in it. Cached across calls so a lost
   * message id (a stream that never reports one) can never make the agent
   * create a brand-new session on every single step.
   */
  private activeChatSessionId?: string;
  private activeMessageId?: string;
  /** The "restored the conversation" notice is shown once per conversation. */
  private reseedNoticeShown = false;

  constructor(options: ModelOptions) {
    this.session = options.session;
    this.modelType = options.modelType;
    this.thinkingEnabled = options.thinkingEnabled ?? true;
    this.searchEnabled = options.searchEnabled ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.activeChatSessionId = options.chatSessionId ?? undefined;
    this.powWasmPath = options.powWasmPath ?? resolvePowWasmPath();
    this.onNotice = options.onNotice;
  }

  /**
   * Tell the user about a non-obvious recovery decision, at most once per
   * conversation (otherwise a multi-step task repeats it every iteration).
   */
  private showLinkageNotice(message: string): void {
    if (this.reseedNoticeShown) return;
    this.reseedNoticeShown = true;
    this.onNotice?.(message);
  }

  /**
   * Forget the DeepSeek-side session linkage. Call this when the conversation
   * changes (new session, switching sessions, /clear) so a cached session from
   * the previous conversation is never reused for a different one.
   */
  resetLinkage(): void {
    this.activeChatSessionId = undefined;
    this.activeMessageId = undefined;
    this.reseedNoticeShown = false;
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
    const lastUserIdx = messages.reduce<number>((best, msg, idx) => {
      if (msg.role === "user" && idx > best) return idx;
      return best;
    }, -1);

    const userPrompt =
      lastUserIdx >= 0 ? messages[lastUserIdx].content : "";

    if (typeof userPrompt !== "string" || userPrompt.trim() === "") {
      throw new ModelError("No user prompt found in the current conversation.");
    }

    // Resolve the DeepSeek chat session to continue. The linkage lives in a
    // resume marker on the last assistant message. When it is missing (an
    // older session file, a lost message id, a chat deleted on the web side)
    // we must never silently send a context-free prompt into a brand-new
    // session — that is how a resumed conversation loses its rules and its
    // whole history. Instead the new session gets re-seeded below.
    let chatSessionId = "";
    let parentMessageId = "";

    let lastAssistant: ChatMessage | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        lastAssistant = messages[i];
        break;
      }
    }

    const marker = lastAssistant
      ? extractResumeMarker(lastAssistant.content ?? "")
      : null;
    if (marker) {
      chatSessionId = marker.chat_session_id;
      parentMessageId = marker.message_id;
    } else if (this.activeChatSessionId) {
      // The conversation already has a session: keep using it. A missing
      // message id means we cannot continue the branch, but it must never
      // cause a brand-new session per step (that used to loop forever,
      // replaying the history and reprinting the notice every iteration).
      chatSessionId = this.activeChatSessionId;
      parentMessageId = this.activeMessageId ?? "";
    } else {
      chatSessionId = await createChatSession(this.session);
      parentMessageId = "";
    }

    // Everything that happened before this turn, used to re-seed a lost
    // session so the model keeps both its tool rules and its context.
    const priorMessages = messages.slice(0, Math.max(lastUserIdx, 0));
    const hasPriorContext = priorMessages.some(
      (m) => m.role === "user" || m.role === "assistant" || m.role === "tool",
    );

    // Build the prompt to send. After tool results, include them so the
    // model can decide whether to continue calling tools or give a final
    // answer. We deliberately do NOT tell it to stop: multi-step tasks need
    // more tool calls after the first result. Iterations are bounded by the
    // agent's maxIterations instead.
    const basePrompt = buildPrompt(userPrompt, messages, lastUserIdx);
    // Without a parent message id there is no branch to continue, so the
    // prompt would land in the session with no memory. Replay the header and
    // earlier turns. The session is reused rather than recreated and the
    // user-facing notice is shown only once.
    const seededPrompt = hasPriorContext
      ? buildSessionSeed(priorMessages, basePrompt)
      : basePrompt;

    if (parentMessageId === "" && hasPriorContext) {
      this.showLinkageNotice(LOST_SESSION_NOTICE);
    }

    // Send the turn. A stale session/parent linkage must never brick the
    // conversation (see sendTurnWithRecovery).
    const turn = await sendTurnWithRecovery(
      { chatSessionId, parentMessageId, basePrompt, seededPrompt },
      (request) =>
        runChat(
          this.session,
          {
            session: this.session,
            chat_session_id: request.chat_session_id,
            parent_message_id: request.parent_message_id,
            prompt: request.prompt,
            model_type: this.modelType,
            thinking_enabled: this.thinkingEnabled,
            search_enabled: this.searchEnabled,
          },
          this.powWasmPath,
        ),
      () => createChatSession(this.session),
      (kind) =>
        this.showLinkageNotice(
          kind === "new-session" ? LOST_SESSION_NOTICE : LOST_PARENT_NOTICE,
        ),
    );
    const result = turn.result;

    // Remember the session and message id for the next step of this
    // conversation, regardless of whether the marker round-trips.
    this.activeChatSessionId = turn.chatSessionId;
    if (result.message_id) this.activeMessageId = result.message_id;

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

    // Only mark a turn that actually produced something. An empty reply (a
    // truncated/failed generation) has an announced message id that may never
    // have been persisted, and storing it would poison the next turn with
    // "invalid message id".
    const producedSomething =
      toolCalls.length > 0 || (out.content ?? "").trim() !== "";
    if (result.message_id && producedSomething) {
      out.content = appendResumeMarker(out.content ?? "", {
        chat_session_id: turn.chatSessionId,
        message_id: result.message_id,
      });
    }

    return out;
  }
}

const LOST_SESSION_NOTICE =
  "Could not continue the previous DeepSeek session — restored this " +
  "conversation's header and history into a new one.";

const LOST_PARENT_NOTICE =
  "DeepSeek rejected the previous message id — continued this conversation " +
  "with its header and history restored.";

/**
 * The prompt for one turn: normally just the last user message, plus the tool
 * results produced since it so the model can decide what to do next.
 */
function buildPrompt(
  userPrompt: string,
  messages: ChatMessage[],
  lastUserIdx: number,
): string {
  const recentResults = messages
    .slice(lastUserIdx + 1)
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : "{}"));
  if (recentResults.length === 0) return userPrompt;

  return (
    "Tool results:\n" +
    recentResults.join("\n") +
    "\n\nTask: " +
    userPrompt +
    "\n\nContinue working on the task. Use more tools if you need more " +
    "information or actions. When the task is fully complete, respond " +
    "with your final answer as plain text."
  );
}

export type LinkageKind = "new-session" | "drop-parent";

export type TurnRequest = {
  chat_session_id: string;
  parent_message_id?: string;
  prompt: string;
};

export type TurnLinkage = {
  chatSessionId: string;
  parentMessageId: string;
  /** Without a parent there is no branch to continue, so the conversation's
   *  header and history are replayed instead. */
  seededPrompt: string;
  basePrompt: string;
};

/**
 * Send one turn, transparently recovering from a stale DeepSeek linkage.
 *
 * DeepSeek answers `biz_code 26 (invalid message id)` when the parent message
 * no longer exists — typically because it came from a reply that never
 * finished — and `biz_code 1 (invalid chat session id)` when the chat itself
 * is gone. Neither is fatal: retry once without a parent (and, if the session
 * is gone, in a fresh one) with the header and history replays, so a resumed
 * conversation continues instead of every future turn failing forever.
 */
export async function sendTurnWithRecovery(
  linkage: TurnLinkage,
  send: (request: TurnRequest) => Promise<ChatResult>,
  createSession: () => Promise<string>,
  onRecover?: (kind: LinkageKind) => void,
): Promise<{ result: ChatResult; chatSessionId: string; recovered: LinkageKind | null }> {
  let chatSessionId = linkage.chatSessionId;
  let parentMessageId = linkage.parentMessageId;
  let prompt =
    parentMessageId === "" ? linkage.seededPrompt : linkage.basePrompt;
  let recovered: LinkageKind | null = null;

  for (;;) {
    try {
      const result = await send({
        chat_session_id: chatSessionId,
        parent_message_id: parentMessageId || undefined,
        prompt,
      });
      return { result, chatSessionId, recovered };
    } catch (error) {
      const kind: LinkageKind | null = recovered
        ? null
        : classifyLinkageError(error);
      if (!kind) throw error;
      recovered = kind;
      if (kind === "new-session") chatSessionId = await createSession();
      parentMessageId = "";
      prompt = linkage.seededPrompt;
      onRecover?.(kind);
    }
  }
}

/**
 * Map a backend error to the linkage recovery it needs, if any:
 *   - "new-session": the chat session itself is gone
 *   - "drop-parent": the chat exists but the parent message id does not
 * Anything else (a mute, a transport failure, a malformed body) is not a
 * linkage problem and must be surfaced as-is.
 */
function classifyLinkageError(error: unknown): LinkageKind | null {
  if (!(error instanceof DeepseekClientError)) return null;
  if (error.bizCode === BIZ_CODE_INVALID_CHAT_SESSION) return "new-session";
  if (error.bizCode === BIZ_CODE_INVALID_MESSAGE_ID) return "drop-parent";
  // In-stream failures may only carry the human-readable text.
  if (/invalid chat session id/i.test(error.message)) return "new-session";
  if (/invalid message id/i.test(error.message)) return "drop-parent";
  return null;
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