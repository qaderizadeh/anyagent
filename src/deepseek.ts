/**
 * chat.deepseek.com over plain HTTPS.
 *
 * This is the whole backend. There is no browser and no local conversation
 * state: the chats live on chat.deepseek.com, and this file only reads and
 * appends to them.
 *
 * Endpoints used:
 *   GET  /api/v0/users/current              is the captured session still good
 *   GET  /api/v0/chat_session/fetch_page    list chats
 *   GET  /api/v0/chat/history_messages      messages of one chat
 *   POST /api/v0/chat_session/create        start a chat
 *   POST /api/v0/chat/create_pow_challenge  proof-of-work challenge
 *   POST /api/v0/chat/completion            send one message (SSE stream)
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

const HOST = (process.env["ANYAGENT_HOST"] ?? "https://chat.deepseek.com").replace(/\/+$/, "");
const COMPLETION = "/api/v0/chat/completion";
const SESSION_FILE = "DEEPSEEK_SESSION_JSON";
const WASM_FILE = "sha3_wasm_bg.wasm";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0";

/** The two headers you copy out of the browser's network tab. */
export type Session = { token: string; cookie: string; ua: string };

export type ChatSession = {
  id: string;
  title: string;
  /** Unix seconds, as reported by the backend. */
  updatedAt: number;
  /** Newest message id in the chat — the parent for the next message. */
  lastMessageId: number;
};

export type HistoryMessage = { id: number; role: string; content: string };
export type Completion = { text: string; messageId?: string };

/**
 * A DeepSeek application-level rejection (biz_code). The agent recovers from
 * `1` (chat gone) and `26` (message id gone) instead of dying.
 */
export class BizError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ */
/* the captured session                                                */
/* ------------------------------------------------------------------ */

function sameToken(raw: unknown): string {
  const value = String(raw ?? "").trim().replace(/^bearer\s+/i, "");
  try {
    const parsed = JSON.parse(value) as { value?: unknown };
    if (parsed && typeof parsed.value === "string") return parsed.value;
  } catch {
    // not JSON, already a bare token
  }
  return value;
}

function sameCookie(raw: unknown): string {
  if (raw != null && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([name, value]) => name !== "" && value != null && String(value) !== "")
      .map(([name, value]) => `${name}=${String(value)}`)
      .join("; ");
  }
  return String(raw ?? "").trim();
}

/**
 * Read the captured session from DEEPSEEK_SESSION_JSON (inline), or from
 * DEEPSEEK_SESSION_PATH / ./DEEPSEEK_SESSION_JSON (a file). The simplest file
 * is just the two request headers:
 *
 *   { "authorization": "Bearer <token>", "cookie": "ds_session_id=...; ..." }
 *
 * `token` and `cookies` are accepted as aliases, and a cookie map works too.
 */
export function loadSession(): Session {
  const inline = (process.env["DEEPSEEK_SESSION_JSON"] ?? "").trim();
  const file = process.env["DEEPSEEK_SESSION_PATH"] ?? path.resolve(process.cwd(), SESSION_FILE);

  let text = inline;
  if (text === "") {
    try {
      text = readFileSync(path.resolve(process.cwd(), file), "utf8").trim();
    } catch {
      text = "";
    }
  }

  if (text !== "") {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`${inline ? "DEEPSEEK_SESSION_JSON" : file} is not valid JSON.`);
    }
    const session: Session = {
      token: sameToken(raw["authorization"] ?? raw["token"]),
      cookie: sameCookie(raw["cookies"] ?? raw["cookie"]),
      ua: String(raw["user_agent"] ?? "").trim() || DEFAULT_UA,
    };
    if (session.token !== "" && session.cookie !== "") return session;
  }

  throw new Error(
    `No DeepSeek session found.\n\n` +
      `Create ${path.resolve(process.cwd(), SESSION_FILE)} with the two request\n` +
      `headers of any chat.deepseek.com API call (DevTools -> Network ->\n` +
      `create_pow_challenge is a good one):\n\n` +
      `  {"authorization": "Bearer <token>", "cookie": "ds_session_id=<...>; ..."}\n`,
  );
}

export function resolveWasmPath(): string {
  const fromEnv = process.env["DEEPSEEK_POW_WASM_PATH"];
  if (fromEnv != null && fromEnv.trim() !== "") return path.resolve(process.cwd(), fromEnv);
  return path.resolve(process.cwd(), WASM_FILE);
}

/* ------------------------------------------------------------------ */
/* http                                                                */
/* ------------------------------------------------------------------ */

function headers(session: Session): Record<string, string> {
  return {
    "User-Agent": session.ua,
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json, */*",
    Origin: HOST,
    Referer: `${HOST}/`,
    Authorization: `Bearer ${session.token}`,
    Cookie: session.cookie,
  };
}

function offline(error: unknown): string {
  const err = error as { message?: string; cause?: { code?: string; message?: string } };
  return [err?.cause?.code, err?.cause?.message ?? err?.message]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(": ");
}

/** Turn a body like {"code":0,"data":{"biz_code":5,"biz_msg":"..."}} into an error. */
function bizFrom(body: string): BizError | null {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  const data = (root["data"] ?? {}) as Record<string, unknown>;
  const code = root["biz_code"] ?? data["biz_code"] ?? root["code"];
  if (typeof code === "number" && code !== 0) {
    const message = root["biz_msg"] ?? data["biz_msg"] ?? root["msg"];
    return new BizError(code, String(message || `biz_code ${code}`));
  }
  return null;
}

async function call(
  session: Session,
  pathname: string,
  init: { method?: string; body?: unknown; extra?: Record<string, string>; timeoutMs?: number } = {},
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(HOST + pathname, {
      method: init.method ?? "GET",
      headers: { ...headers(session), ...(init.extra ?? {}) },
      body: init.body == null ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });
  } catch (error) {
    throw new Error(`Cannot reach chat.deepseek.com (${pathname}): ${offline(error) || "unknown network error"}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`chat.deepseek.com returned HTTP ${response.status} for ${pathname}\n${text.slice(0, 300)}`);
  }
  const biz = bizFrom(text);
  if (biz) throw biz;
  return text;
}

/** The payload of a normal {"code":0,"data":{"biz_data":{...}}} reply. */
function payload(text: string): Record<string, unknown> {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Unexpected response from chat.deepseek.com:\n${text.slice(0, 300)}`);
  }
  const data = (root["data"] ?? {}) as Record<string, unknown>;
  const inner = data["biz_data"];
  return (inner && typeof inner === "object" ? inner : data) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* endpoints                                                           */
/* ------------------------------------------------------------------ */

/** Cheap check that the captured session is still accepted. */
export async function verifySession(session: Session): Promise<void> {
  const root = JSON.parse(await call(session, "/api/v0/users/current")) as Record<string, unknown>;
  if (root["code"] !== 0) {
    throw new Error(`DeepSeek rejected the session:\n${JSON.stringify(root).slice(0, 300)}`);
  }
}

/** The account's chats — this is the project's session store. */
export async function listSessions(session: Session, count = 10): Promise<ChatSession[]> {
  const query = count >= 2 ? `?count=${count}` : ""; // the backend rejects count < 2
  const data = payload(await call(session, `/api/v0/chat_session/fetch_page${query}`));
  const list = data["chat_sessions"];
  if (!Array.isArray(list)) return [];
  return list
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      id: String(item["id"] ?? ""),
      title: String(item["title"] ?? "").trim() || "(untitled)",
      updatedAt: Number(item["updated_at"] ?? 0),
      lastMessageId: Number(item["current_message_id"] ?? 0),
    }))
    .filter((item) => item.id !== "");
}

export async function createSession(session: Session): Promise<string> {
  const text = await call(session, "/api/v0/chat_session/create", {
    method: "POST",
    body: { agent: "chat" },
  });
  const root = JSON.parse(text) as Record<string, unknown>;
  const data = (root["data"] ?? {}) as Record<string, unknown>;
  const inner = (data["biz_data"] ?? data) as Record<string, unknown>;
  const id = inner["id"] ?? data["id"] ?? root["id"];
  if (typeof id !== "string" || id === "") throw new Error(`Could not create a chat:\n${text.slice(0, 300)}`);
  return id;
}

/** Every message of a chat, oldest first. */
export async function history(session: Session, chatId: string): Promise<HistoryMessage[]> {
  const data = payload(
    await call(session, `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(chatId)}`),
  );
  const list = data["chat_messages"];
  if (!Array.isArray(list)) return [];
  return list
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      id: Number(item["message_id"] ?? 0),
      role: String(item["role"] ?? ""),
      content: String(item["content"] ?? ""),
    }));
}

/* ------------------------------------------------------------------ */
/* reading one answer                                                  */
/* ------------------------------------------------------------------ */

/**
 * The fragment kinds that are the reply itself. Everything else a message is
 * made of - THINK, SEARCH, a kind that does not exist yet - is not the answer,
 * so it is dropped rather than shown or run as a command.
 */
const ANSWER_KINDS = new Set(["RESPONSE", "ANSWER", "TEXT", "CONTENT"]);

export type StreamReader = {
  /** Feed one SSE line. Throws BizError when the stream reports one. */
  feed(line: string): void;
  /** The answer so far, without any of the model's reasoning. */
  text(): string;
  messageId(): string;
};

/**
 * Read the streamed reply.
 *
 * The payload is a pointer stream: each `data:` line names a path and changes
 * what is at it. A message arrives as a list of typed fragments - the thinking
 * is one, the reply another - and the rest of each fragment follows as appends
 * to `response/fragments/-1/content`, which do NOT repeat the type. So the
 * kind of the last fragment is remembered here, and it starts as "not the
 * answer": only a fragment that says it is the reply is read.
 */
export function createStreamReader(): StreamReader {
  let answer = "";
  let messageId = "";
  let field = ""; // the last path seen, for changes that omit it
  let kind: "think" | "answer" = "think";
  let event = "";

  const fragments = (list: unknown[]): void => {
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const fragment = raw as Record<string, unknown>;
      const type = String(fragment["type"] ?? "").toUpperCase();
      kind = type === "" || ANSWER_KINDS.has(type) ? "answer" : "think";
      if (kind === "answer" && typeof fragment["content"] === "string") answer += fragment["content"];
    }
  };

  const apply = (at: string, value: unknown, op: unknown): void => {
    if (Array.isArray(value)) {
      fragments(value);
      return;
    }
    // A whole-message snapshot, e.g. {"v":{"response":{"content":"..."}}}.
    if (value != null && typeof value === "object") {
      const response = (value as Record<string, unknown>)["response"];
      if (response && typeof response === "object") {
        const full = response as Record<string, unknown>;
        if (typeof full["content"] === "string") answer = full["content"];
        if (full["message_id"] != null) messageId = String(full["message_id"]);
      }
      return;
    }
    if (typeof value !== "string") return;

    // The same list can arrive as a JSON string.
    if (at.includes("fragments") && value.trimStart().startsWith("[")) {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (Array.isArray(parsed)) return fragments(parsed);
      } catch {
        // not a JSON fragment list after all
      }
    }

    if (at.endsWith("message_id")) {
      messageId = value;
      return;
    }
    if (at.includes("thinking")) return; // the model's reasoning
    if (at === "response/content") {
      answer = op === "SET" ? value : answer + value;
      return;
    }
    if (at.includes("content") && kind === "answer") answer += value; // an append to the last fragment
  };

  return {
    feed(line: string): void {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith(":")) return;
      if (trimmed.startsWith("event:")) {
        event = trimmed.slice(6).trim();
        return;
      }
      if (!trimmed.startsWith("data:")) return;

      const data = trimmed.slice(5).trim();
      if (data === "" || data === "[DONE]") return;

      let item: Record<string, unknown>;
      try {
        item = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }

      // An error inside the stream must surface, never look like an empty reply.
      const nested = (item["data"] ?? {}) as Record<string, unknown>;
      const code = item["biz_code"] ?? nested["biz_code"];
      if (typeof code === "number" && code !== 0) {
        throw new BizError(code, String(item["biz_msg"] ?? nested["biz_msg"] ?? `biz_code ${code}`));
      }
      if (typeof item["code"] === "number" && item["code"] !== 0) {
        throw new BizError(item["code"], String(item["msg"] ?? `code ${item["code"]}`));
      }

      if (event === "ready" && item["response_message_id"] != null) {
        messageId = String(item["response_message_id"]);
      }
      event = "";
      if (typeof item["p"] === "string") field = item["p"];
      apply(field, item["v"], item["o"]);
    },
    text: () => answer,
    messageId: () => messageId,
  };
}

/** A cut connection returns nothing while DeepSeek keeps generating, so look for the answer before asking again. */
async function recoverAnswer(session: Session, chatId: string, afterId: number): Promise<Completion | null> {
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise((done) => setTimeout(done, 2_000));
    const messages = await history(session, chatId).catch(() => []);
    const mine = messages.filter((message) => message.role === "ASSISTANT" && message.id > afterId);
    if (mine.length === 0) {
      if (attempt >= 2) return null; // the turn was never stored
      continue;
    }
    const answer = mine.filter((message) => message.content.trim() !== "").pop();
    if (answer) return { text: answer.content, messageId: String(answer.id) };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* proof of work                                                       */
/* ------------------------------------------------------------------ */

/**
 * The x-ds-pow-response header the backend asks for, worked out with the
 * vendored sha3 wasm, or null if this build cannot work it out.
 *
 * Best effort on purpose: the request is sent either way, so a solver that
 * cannot cope shows up as the backend's own answer instead of a local dead end
 * that says nothing about why.
 */
async function powHeader(session: Session, targetPath: string, wasmPath: string): Promise<string | null> {
  const raw = await call(session, "/api/v0/chat/create_pow_challenge", {
    method: "POST",
    body: { target_path: targetPath },
  });
  const root = JSON.parse(raw) as Record<string, unknown>;
  const data = (root["data"] ?? {}) as Record<string, unknown>;
  const inner = (data["biz_data"] ?? {}) as Record<string, unknown>;
  const challenge = (inner["challenge"] ?? data["challenge"] ?? data) as Record<string, unknown>;
  if (!challenge || typeof challenge !== "object") {
    throw new Error(`Unexpected pow challenge:\n${raw.slice(0, 300)}`);
  }

  // It ships with the project, next to the code that uses it.
  const bytes = await readFile(wasmPath).catch(() => null);
  if (!bytes) return null;

  const { instance } = await WebAssembly.instantiate(bytes, {});
  const exports = instance.exports;
  const memory = exports["memory"] as WebAssembly.Memory | undefined;
  const malloc = exports["__wbindgen_export_0"] as ((size: number, align: number) => number) | undefined;
  const push = exports["__wbindgen_add_to_stack_pointer"] as ((delta: number) => number) | undefined;
  const solve = exports["wasm_solve"] as
    | ((ret: number, cPtr: number, cLen: number, pPtr: number, pLen: number, difficulty: number) => void)
    | undefined;
  if (!memory || !malloc || !push || !solve) return null;

  const encoder = new TextEncoder();
  const write = (value: string): { ptr: number; len: number } => {
    const encoded = encoder.encode(value);
    const ptr = malloc(encoded.length, 1) >>> 0;
    new Uint8Array(memory.buffer).set(encoded, ptr);
    return { ptr, len: encoded.length };
  };

  const salt = String(challenge["salt"] ?? "");
  const challengeText = String(challenge["challenge"] ?? "");
  const expireAt = Number(challenge["expire_at"] ?? 0);
  const difficulty = Number(challenge["difficulty"] ?? 0);

  const ret = push(-16);
  try {
    const c = write(challengeText);
    const p = write(`${salt}_${expireAt}_`);
    solve(ret, c.ptr, c.len, p.ptr, p.len, difficulty);
    const view = new DataView(memory.buffer);
    const solved = view.getInt32(ret, true);
    const answer = view.getFloat64(ret + 8, true);
    if (solved === 0 || !Number.isFinite(answer)) return null;
    return Buffer.from(
      JSON.stringify({
        algorithm: challenge["algorithm"],
        challenge: challengeText,
        salt,
        answer: Math.floor(answer),
        signature: challenge["signature"],
        target_path: challenge["target_path"],
      }),
      "utf8",
    ).toString("base64");
  } finally {
    push(16);
  }
}

/* ------------------------------------------------------------------ */
/* sending one message                                                 */
/* ------------------------------------------------------------------ */

export type Turn = {
  chatId: string;
  prompt: string;
  parentId?: number | string;
  thinking?: boolean;
  search?: boolean;
  modelType?: string;
};

export async function complete(session: Session, turn: Turn, wasmPath: string): Promise<Completion> {
  const pow = await powHeader(session, COMPLETION, wasmPath).catch(() => null);

  const body: Record<string, unknown> = {
    chat_session_id: turn.chatId,
    prompt: turn.prompt,
    ref_file_ids: [],
    thinking_enabled: turn.thinking ?? true,
    search_enabled: turn.search ?? false,
  };
  if (turn.parentId != null && turn.parentId !== "") {
    body["parent_message_id"] = Number(turn.parentId) || turn.parentId;
  }
  if (turn.modelType) body["model_type"] = turn.modelType;

  let response: Response;
  try {
    response = await fetch(`${HOST}${COMPLETION}`, {
      method: "POST",
      headers: pow === null ? headers(session) : { ...headers(session), "x-ds-pow-response": pow },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
  } catch (error) {
    throw new Error(`Cannot reach chat.deepseek.com (${COMPLETION}): ${offline(error) || "unknown network error"}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`chat completion failed: HTTP ${response.status}\n${text.slice(0, 300)}`);
  }

  // Anything that is not a stream is a backend failure, never an empty answer.
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const text = await response.text().catch(() => "");
    throw bizFrom(text) ?? new Error(`Unexpected completion response:\n${text.slice(0, 300)}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("chat completion returned an empty body.");

  const stream = createStreamReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.indexOf("\n");
      while (end !== -1) {
        stream.feed(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        end = buffer.indexOf("\n");
      }
    }
    if (buffer !== "") stream.feed(buffer);
  } finally {
    reader.cancel().catch(() => {});
  }

  const text = stream.text();
  if (text.trim() === "") {
    const recovered = await recoverAnswer(session, turn.chatId, Number(turn.parentId) || 0);
    if (recovered) return recovered;
  }
  return { text, messageId: stream.messageId() || undefined };
}
