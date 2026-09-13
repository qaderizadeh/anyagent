/**
 * DeepSeek web transport.
 *
 * Everything the agent needs to talk to chat.deepseek.com, and nothing else.
 * There is no local conversation state anywhere in this project: the session
 * list and all messages live on chat.deepseek.com, and this file just reads
 * and appends to them.
 *
 * Endpoints used:
 *   GET  /api/v0/users/current              verify the captured session
 *   GET  /api/v0/chat_session/fetch_page    list chat sessions
 *   GET  /api/v0/chat/history_messages      messages of one chat session
 *   POST /api/v0/chat_session/create        start a chat session
 *   POST /api/v0/chat/create_pow_challenge  proof-of-work challenge
 *   POST /api/v0/chat/completion            send a turn (SSE stream)
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

const HOST = "https://chat.deepseek.com";
const SESSION_FILE = "DEEPSEEK_SESSION_JSON";
const WASM_FILE = "sha3_wasm_bg.wasm";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0";

/** The two headers you copy out of the browser's network tab. */
export type Session = {
  token: string;
  cookie: string;
  ua: string;
};

export type ChatSession = {
  id: string;
  title: string;
  /** Unix seconds, as reported by the backend. */
  updatedAt: number;
  /** Newest message id in the chat — used as the parent for the next turn. */
  lastMessageId: number;
};

export type HistoryMessage = {
  id: number;
  role: "USER" | "ASSISTANT" | string;
  content: string;
};

export type Completion = {
  text: string;
  messageId?: string;
};

/**
 * A DeepSeek application-level rejection (biz_code). Callers recover from
 * `1` (chat session gone) and `26` (message id gone) instead of dying.
 */
export class BizError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* session capture                                                     */
/* ------------------------------------------------------------------ */

function bareToken(raw: unknown): string {
  let value = String(raw ?? "").trim().replace(/^bearer\s+/i, "");
  try {
    const parsed = JSON.parse(value) as { value?: unknown };
    if (parsed && typeof parsed.value === "string") value = parsed.value;
  } catch {
    // not JSON — already a bare token
  }
  return value;
}

function cookieHeader(raw: unknown): string {
  const fromMap = (map: object): string =>
    Object.entries(map)
      .filter(([k, v]) => k !== "" && v != null && String(v) !== "")
      .map(([k, v]) => `${k}=${String(v)}`)
      .join("; ");

  if (raw == null) return "";
  if (typeof raw === "object") return fromMap(raw);
  const value = String(raw).trim();
  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object") return fromMap(parsed as object);
    } catch {
      // not JSON — treat it as a raw header value
    }
  }
  return value;
}

function sessionFrom(raw: Record<string, unknown>): Session {
  const token = bareToken(raw["authorization"] ?? raw["token"]);
  const cookie = cookieHeader(raw["cookies"] ?? raw["cookie"]);
  const ua = String(raw["user_agent"] ?? "").trim() || DEFAULT_UA;
  return { token, cookie, ua };
}

/**
 * Read the captured session from, in order:
 *   1. DEEPSEEK_SESSION_JSON (inline JSON)
 *   2. DEEPSEEK_SESSION_PATH (a file)
 *   3. ./DEEPSEEK_SESSION_JSON (the default file)
 *
 * The simplest file is just the two request headers:
 *   { "authorization": "Bearer <token>", "cookie": "ds_session_id=...; ..." }
 * `token` and `cookies` are accepted as aliases, and a cookie map works too.
 */
export function loadSession(): Session {
  const sources: Array<{ label: string; read: () => string }> = [
    {
      label: "DEEPSEEK_SESSION_JSON",
      read: () => process.env["DEEPSEEK_SESSION_JSON"] ?? "",
    },
    {
      label: "DEEPSEEK_SESSION_PATH",
      read: () => readFileSync(path.resolve(process.cwd(), process.env["DEEPSEEK_SESSION_PATH"] ?? ""), "utf8"),
    },
    {
      label: path.resolve(process.cwd(), SESSION_FILE),
      read: () => readFileSync(path.resolve(process.cwd(), SESSION_FILE), "utf8"),
    },
  ];

  for (const source of sources) {
    let text: string;
    try {
      text = source.read().trim();
    } catch {
      continue;
    }
    if (text === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${source.label} is not valid JSON.`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`${source.label} must be a JSON object.`);
    }

    const session = sessionFrom(parsed as Record<string, unknown>);
    if (session.token === "" || session.cookie === "") {
      throw new Error(
        `${source.label} needs both credentials.\n\n` +
          `Copy the two request headers of any chat.deepseek.com API call\n` +
          `(DevTools -> Network -> create_pow_challenge is a good one):\n\n` +
          `  {"authorization": "Bearer <token>", "cookie": "ds_session_id=<...>; ..."}\n`,
      );
    }
    return session;
  }

  throw new Error(
    `No DeepSeek session found.\n\n` +
      `Create ${path.resolve(process.cwd(), SESSION_FILE)} with:\n\n` +
      `  {"authorization": "Bearer <token>", "cookie": "ds_session_id=<...>; ..."}\n\n` +
      `1. Open https://chat.deepseek.com and sign in.\n` +
      `2. DevTools -> Network, click any /api/v0/... request.\n` +
      `3. Copy the "authorization" and "cookie" request headers into the file.\n`,
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

function transportMessage(error: unknown): string {
  const err = error as { message?: string; cause?: { code?: string; message?: string } };
  const parts = [err?.cause?.code, err?.cause?.message ?? err?.message].filter(
    (part): part is string => typeof part === "string" && part !== "",
  );
  return parts.join(": ") || "unknown network error";
}

/** Turn a non-SSE body like {"code":0,"data":{"biz_code":5,...}} into an error. */
function bizFrom(body: string): BizError | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const root = parsed as Record<string, unknown>;
  const data = (root["data"] ?? {}) as Record<string, unknown>;
  const code = root["biz_code"] ?? data["biz_code"];
  const message = root["biz_msg"] ?? data["biz_msg"];
  if (typeof code === "number" && code !== 0) {
    return new BizError(code, String(message || `biz_code ${code}`));
  }
  const outer = root["code"];
  if (typeof outer === "number" && outer !== 0) {
    return new BizError(outer, String(root["msg"] || `code ${outer}`));
  }
  return null;
}

async function get(session: Session, pathname: string, timeoutMs = 30_000): Promise<string> {
  let resp: Response;
  try {
    resp = await fetch(HOST + pathname, {
      headers: headers(session),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Cannot reach chat.deepseek.com (${pathname}): ${transportMessage(error)}`);
  }
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`chat.deepseek.com returned HTTP ${resp.status} for ${pathname}\n${text.slice(0, 300)}`);
  }
  const biz = bizFrom(text);
  if (biz) throw biz;
  return text;
}

async function post(
  session: Session,
  pathname: string,
  body: unknown,
  extra: Record<string, string> = {},
  timeoutMs = 30_000,
): Promise<string> {
  let resp: Response;
  try {
    resp = await fetch(HOST + pathname, {
      method: "POST",
      headers: { ...headers(session), ...extra },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Cannot reach chat.deepseek.com (${pathname}): ${transportMessage(error)}`);
  }
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`chat.deepseek.com returned HTTP ${resp.status} for ${pathname}\n${text.slice(0, 300)}`);
  }
  return text;
}

function json(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Unexpected response from chat.deepseek.com:\n${text.slice(0, 300)}`);
  }
}

function bizData(text: string): Record<string, unknown> {
  const root = json(text);
  const biz = bizFrom(text);
  if (biz) throw biz;
  const data = (root["data"] ?? {}) as Record<string, unknown>;
  const inner = data["biz_data"];
  return (inner && typeof inner === "object" ? inner : data) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* endpoints                                                           */
/* ------------------------------------------------------------------ */

/** Cheap check that the captured session is still accepted. */
export async function verifySession(session: Session): Promise<void> {
  const root = json(await get(session, "/api/v0/users/current"));
  if (root["code"] !== 0) {
    throw new Error(`DeepSeek rejected the session:\n${JSON.stringify(root).slice(0, 300)}`);
  }
}

/** The account's chat sessions — this is the project's "session store". */
export async function listSessions(session: Session, count = 20): Promise<ChatSession[]> {
  // The backend rejects count < 2 with ILLEGAL_COUNT; omit it to take the default.
  const query = count >= 2 ? `?count=${count}` : "";
  const data = bizData(await get(session, `/api/v0/chat_session/fetch_page${query}`));
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
  const raw = await post(session, "/api/v0/chat_session/create", { agent: "chat" });
  const root = json(raw);
  const data = (root["data"] ?? {}) as Record<string, unknown>;
  const inner = (data["biz_data"] ?? data) as Record<string, unknown>;
  const id = inner["id"] ?? data["id"] ?? root["id"];
  if (typeof id !== "string" || id === "") {
    throw new Error(`Could not create a chat session:\n${raw.slice(0, 300)}`);
  }
  return id;
}

/** Every message of a chat session, oldest first. */
export async function history(session: Session, chatId: string): Promise<HistoryMessage[]> {
  const data = bizData(
    await get(session, `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(chatId)}`),
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
/* proof of work                                                       */
/* ------------------------------------------------------------------ */

async function powChallenge(session: Session, targetPath: string): Promise<Record<string, unknown>> {
  const raw = await post(session, "/api/v0/chat/create_pow_challenge", { target_path: targetPath });
  const root = json(raw);
  const data = (root["data"] ?? {}) as Record<string, unknown>;
  const inner = (data["biz_data"] ?? {}) as Record<string, unknown>;
  const challenge = inner["challenge"] ?? data["challenge"] ?? data;
  if (!challenge || typeof challenge !== "object") {
    throw new Error(`Unexpected pow challenge:\n${raw.slice(0, 300)}`);
  }
  return challenge as Record<string, unknown>;
}

/** Solve the challenge with the vendored sha3 wasm and return the x-ds-pow-response header. */
export async function signPow(session: Session, targetPath: string, wasmPath: string): Promise<string> {
  const challenge = await powChallenge(session, targetPath);

  const bytes = await readFile(wasmPath).catch(() => {
    throw new Error(
      `Cannot read the proof-of-work binary at ${wasmPath}.\n` +
        `It ships with the project (${WASM_FILE}); run anyagent from the project directory.`,
    );
  });

  const { instance } = await WebAssembly.instantiate(bytes, {});
  const exports = instance.exports as Record<string, unknown>;
  const memory = exports["memory"] as WebAssembly.Memory | undefined;
  const malloc = exports["__wbindgen_export_0"] as ((size: number, align: number) => number) | undefined;
  const addStackPointer = exports["__wbindgen_add_to_stack_pointer"] as ((delta: number) => number) | undefined;
  const solve = exports["wasm_solve"] as
    | ((ret: number, cPtr: number, cLen: number, pPtr: number, pLen: number, difficulty: number) => void)
    | undefined;

  if (!memory || !malloc || !addStackPointer || !solve) {
    throw new Error(`${wasmPath} is not the expected sha3 wasm build.`);
  }

  const encoder = new TextEncoder();
  const write = (value: string): { ptr: number; len: number } => {
    const encoded = encoder.encode(value);
    const ptr = malloc(encoded.length, 1) >>> 0;
    new Uint8Array(memory.buffer).set(encoded, ptr);
    return { ptr, len: encoded.length };
  };

  const salt = String(challenge["salt"] ?? "");
  const expireAt = Number(challenge["expire_at"] ?? 0);
  const difficulty = Number(challenge["difficulty"] ?? 0);
  const challengeText = String(challenge["challenge"] ?? "");

  const ret = addStackPointer(-16);
  try {
    const c = write(challengeText);
    const p = write(`${salt}_${expireAt}_`);
    solve(ret, c.ptr, c.len, p.ptr, p.len, difficulty);

    const view = new DataView(memory.buffer);
    const ok = view.getInt32(ret, true);
    const answer = view.getFloat64(ret + 8, true);
    if (ok === 0 || !Number.isFinite(answer)) {
      throw new Error("Proof-of-work could not be solved.");
    }

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
    addStackPointer(16);
  }
}

/* ------------------------------------------------------------------ */
/* completion                                                          */
/* ------------------------------------------------------------------ */

export type Turn = {
  chatId: string;
  prompt: string;
  parentId?: number | string;
  thinking?: boolean;
  search?: boolean;
  modelType?: string;
};

/**
 * Send one turn and read the streamed reply.
 *
 * The SSE payload is a pointer stream:
 *   {"p":"response/content","o":"APPEND","v":"Hello"}   append to the answer
 *   {"p":"response/status","v":"FINISHED"}              turn finished
 * `event: ready` carries the assistant message id we need as the next parent.
 */
export async function complete(session: Session, turn: Turn, wasmPath: string): Promise<Completion> {
  const pow = await signPow(session, "/api/v0/chat/completion", wasmPath);

  const body: Record<string, unknown> = {
    chat_session_id: turn.chatId,
    prompt: turn.prompt,
    ref_file_ids: [],
    thinking_enabled: turn.thinking ?? true,
    search_enabled: turn.search ?? false,
  };
  if (turn.parentId != null && turn.parentId !== "") body["parent_message_id"] = Number(turn.parentId) || turn.parentId;
  if (turn.modelType) body["model_type"] = turn.modelType;

  let resp: Response;
  try {
    resp = await fetch(`${HOST}/api/v0/chat/completion`, {
      method: "POST",
      headers: { ...headers(session), "x-ds-pow-response": pow },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
  } catch (error) {
    throw new Error(`Cannot reach chat.deepseek.com (/api/v0/chat/completion): ${transportMessage(error)}`);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`chat completion failed: HTTP ${resp.status}\n${text.slice(0, 300)}`);
  }

  // Anything that is not an event stream is a backend-level failure, never an
  // empty answer.
  if (!(resp.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const text = await resp.text().catch(() => "");
    throw bizFrom(text) ?? new Error(`Unexpected completion response:\n${text.slice(0, 300)}`);
  }

  const reader = resp.body?.getReader();
  if (!reader) throw new Error("chat completion returned an empty body.");

  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let messageId = "";
  let field = "";
  let event = "";

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith(":")) return;
    if (trimmed.startsWith("event:")) {
      event = trimmed.slice(6).trim();
      return;
    }
    if (!trimmed.startsWith("data:")) return;

    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const item = parsed as Record<string, unknown>;

    // In-stream application errors must surface, not look like an empty reply.
    const outer = item["code"];
    const inner = (item["data"] ?? {}) as Record<string, unknown>;
    const bizCode = item["biz_code"] ?? inner["biz_code"];
    if ((typeof outer === "number" && outer !== 0) || (typeof bizCode === "number" && bizCode !== 0)) {
      const code = typeof bizCode === "number" ? bizCode : (outer as number);
      throw new BizError(code, String(item["biz_msg"] ?? inner["biz_msg"] ?? `biz_code ${code}`));
    }

    if (event === "ready" && item["response_message_id"] != null) {
      messageId = String(item["response_message_id"]);
    }
    event = "";

    if (typeof item["p"] === "string") field = item["p"];

    const value = item["v"];
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      const response = (value as Record<string, unknown>)["response"];
      if (response && typeof response === "object") {
        const full = response as Record<string, unknown>;
        if (typeof full["content"] === "string") text = full["content"];
        if (full["message_id"] != null) messageId = String(full["message_id"]);
      }
    } else if (typeof value === "string" && (field === "response/content" || field === "")) {
      text += value;
    }

    if (field === "response/message_id" && (typeof value === "number" || typeof value === "string")) {
      messageId = String(value);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        handleLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    }
    if (buffer !== "") handleLine(buffer);
  } finally {
    reader.cancel().catch(() => {});
  }

  return { text, messageId: messageId || undefined };
}
