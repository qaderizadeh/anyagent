/** Minimal direct client for chat.deepseek.com.

 * No API key. No OpenAI shim. No port. The agent uses this module to:
 *   1. load a pasted/deployed session from DEEPSEEK_SESSION_PATH or
 *      DEEPSEEK_SESSION_JSON
 *   2. verify the session is usable (a lightweight real request)
 *   3. sign a proof-of-work challenge using the vendored sha3_wasm_bg.wasm
 *   4. post a completion and parse the SSE stream
 *
 * The protocol approximately follows current DeepSeek web chat behavior.
 * DeepSeek may change it without notice; if things break, the README has
 * the exact fields the project currently uses so you can update them in
 * one place.
 */

import * as fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

export type DeepseekSession = {
  token: string;
  cookies: Record<string, string>;
  user_agent: string;
  client_headers?: Record<string, string>;
};

export type DeepseekSessionFile = DeepseekSession & {
  captured_at?: string | null;
  max_age_ms?: number;
};

export type DeepseekError = {
  type: "invalid-session" | "backend-error" | "pow-error" | "parse-error" | "unknown";
  message: string;
};

export class DeepseekClientError extends Error {
  readonly kind: DeepseekError["type"];
  constructor(kind: DeepseekError["type"], message: string) {
    super(message);
    this.name = "DeepseekClientError";
    this.kind = kind;
  }
}

const DEFAULT_SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

function envPathOrJson(
  pathEnv: string,
  jsonEnv: string,
  filePath: string,
): DeepseekSessionFile | null {
  const jsonEnvValue = process.env[jsonEnv];
  if (jsonEnvValue != null && jsonEnvValue.trim() !== "") {
    try {
      return JSON.parse(jsonEnvValue) as DeepseekSessionFile;
    } catch {
      throw new DeepseekClientError(
        "invalid-session",
        `Environment variable ${jsonEnv} is set but is not valid JSON.`,
      );
    }
  }

  const pathEnvValue = process.env[pathEnv];
  if (pathEnvValue != null && pathEnvValue.trim() !== "") {
    const candidate = path.resolve(process.cwd(), pathEnvValue);
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      if (raw.trim() === "") return null;
      return JSON.parse(raw) as DeepseekSessionFile;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DeepseekClientError(
        "invalid-session",
        `Cannot read session file from ${candidate}: ${message}`,
      );
    }
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (raw.trim() === "") return null;
    return JSON.parse(raw) as DeepseekSessionFile;
  } catch {
    return null;
  }
}

function hostUrl(pathname: string): string {
  // Allow overriding the backend (useful behind proxies and for tests).
  const base = process.env["DEEPSEEK_BASE_URL"];
  if (base != null && base.trim() !== "") {
    return base.replace(/\/+$/, "") + pathname;
  }
  return `https://chat.deepseek.com${pathname}`;
}

export function defaultSessionPath(): string {
  return path.resolve(process.cwd(), "DEEPSEEK_SESSION_JSON");
}

export function describeSessionIssue(raw: DeepseekError): string {
  if (raw.type === "invalid-session") {
    return (
      "DeepSeek session is missing or invalid.\n" +
      "\n" +
      "Before the agent can run, you need a DeepSeek web session.\n" +
      "The project stores it in a small JSON file, by default:\n" +
      `  ${defaultSessionPath()}\n` +
      "\n" +
      "You can also paste it inline via DEEPSEEK_SESSION_JSON or point at\n" +
      "any file with DEEPSEEK_SESSION_PATH.\n" +
      "\n" +
      "Expected shape:\n" +
      JSON.stringify(
        {
          token: "your-session-token",
          cookies: { ds_session_id: "...", other_cookie: "..." },
          user_agent: "Mozilla/5.0 ... Chrome/... Safari/537.36",
          client_headers: { "x-app-version": "2.0.0", "x-client-version": "2.0.0" },
          captured_at: new Date().toISOString(),
          max_age_ms: DEFAULT_SESSION_MAX_AGE_MS,
        },
        null,
        2,
      ) +
      "\n" +
      "\n" +
      "How to create one:\n" +
      "1. Open https://chat.deepseek.com in your browser.\n" +
      "2. Sign in once if you are not signed in.\n" +
      "3. Open the browser developer console on that page.\n" +
      "4. Run a small console snippet that reads your token and cookies,\n" +
      "   then copy the printed JSON.\n" +
      "5. Paste it into the session file, or run again with the JSON in\n" +
      "   DEEPSEEK_SESSION_JSON.\n" +
      "\n" +
      raw.message
    );
  }

  if (raw.type === "backend-error") {
    return (
      "chat.deepseek.com did not behave as expected.\n" +
      "\n" +
      raw.message +
      "\n" +
      "\n" +
      "This usually means either:\n" +
      "  - your session expired or the site changed its API,\n" +
      "  - the request was blocked before it reached the chat backend.\n" +
      "\n" +
      "Try re-capturing the session and running again."
    );
  }

  if (raw.type === "pow-error") {
    return (
      "Proof-of-work could not be produced.\n" +
      "\n" +
      raw.message +
      "\n" +
      "\n" +
      "The agent uses a local sha3_wasm_bg.wasm binary to solve the\n" +
      "DeepSeek request challenge. If that binary is missing or outdated,\n" +
      "the agent will ask you to refresh it.\n" +
      "\n" +
      "You can override the wasm path with:\n" +
      "  DEEPSEEK_POW_WASM_PATH=/path/to/sha3_wasm_bg.wasm\n" +
      "\n" +
      "If DeepSeek changed the pow worker, update the vendored wasm binary\n" +
      "and rerun."
    );
  }

  if (raw.type === "parse-error") {
    return (
      "Could not parse a DeepSeek response.\n" +
      "\n" +
      raw.message +
      "\n" +
      "\n" +
      "The site may have changed the wire format. Check the README for\n" +
      "the current fields and update src/deepseek.ts if needed."
    );
  }

  return (
    "Unexpected problem contacting DeepSeek.\n" +
    "\n" +
    raw.message
  );
}

export function sessionFreshnessOk(
  session: DeepseekSessionFile | null,
): boolean {
  if (!session) return false;
  const rawCaptured = session.captured_at;
  const captured = rawCaptured ? new Date(rawCaptured) : null;
  if (!captured || isNaN(captured.getTime())) return true;
  const maxAge = session.max_age_ms ?? DEFAULT_SESSION_MAX_AGE_MS;
  return Date.now() - captured.getTime() <= maxAge;
}

/**
 * chat.deepseek.com now stores its auth token in localStorage wrapped as
 * {"value":"<token>","__version":"0"}. The API only accepts the inner
 * value in the Authorization header. Accept either form.
 */
export function normalizeToken(raw: string): string {
  if (raw == null || raw === "") return raw ?? "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.value === "string") {
      return parsed.value;
    }
  } catch {
    // not JSON — already the raw token
  }
  return raw;
}

export function buildSessionHeaders(session: DeepseekSession): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": session.user_agent,
    Origin: "https://chat.deepseek.com",
    Referer: "https://chat.deepseek.com/",
    Accept: "text/event-stream, application/json, */*",
    "Content-Type": "application/json",
  };

  if (session.token) {
    headers["Authorization"] = `Bearer ${normalizeToken(session.token)}`;
  }

  const cookieParts = Object.entries(session.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  if (cookieParts) {
    headers["Cookie"] = cookieParts;
  }

  for (const [key, value] of Object.entries(session.client_headers ?? {})) {
    headers[key] = value;
  }

  return headers;
}

export async function loadSession(): Promise<DeepseekSessionFile> {
  const filePath = defaultSessionPath();
  const raw = envPathOrJson(
    "DEEPSEEK_SESSION_PATH",
    "DEEPSEEK_SESSION_JSON",
    filePath,
  );

  if (!raw) {
    throw new DeepseekClientError(
      "invalid-session",
      `No DeepSeek session found.\n\nChecked:\n  ${filePath}\n  DEEPSEEK_SESSION_PATH\n  DEEPSEEK_SESSION_JSON\n\n` +
        describeSessionIssue({
          type: "invalid-session",
          message: "No session file or env was provided.",
        }),
    );
  }

  if (!sessionFreshnessOk(raw)) {
    throw new DeepseekClientError(
      "invalid-session",
      `Saved DeepSeek session may be too old.\n\n` +
        describeSessionIssue({
          type: "invalid-session",
          message: `Session was captured at ${raw.captured_at ?? "unknown"}. ` +
            `Refresh it by re-capturing from chat.deepseek.com.`,
        }),
    );
  }

  // The shipped placeholder is not a real session: guide the user to
  // capture one instead of failing against the backend.
  if (raw.token === "your-session-token") {
    throw new DeepseekClientError(
      "invalid-session",
      `The session file still contains the placeholder values.\n\n` +
        describeSessionIssue({
          type: "invalid-session",
          message: "Replace the placeholder token and cookies with your real DeepSeek session.",
        }),
    );
  }

  if ((raw.token == null || raw.token === "") && Object.keys(raw.cookies ?? {}).length === 0) {
    throw new DeepseekClientError(
      "invalid-session",
      `Session file exists but has no token or cookies.\n\n` +
        describeSessionIssue({
          type: "invalid-session",
          message: "Fill in token and cookies in the session file.",
        }),
    );
  }

  return raw;
}

export async function verifySession(session: DeepseekSession): Promise<void> {
  const headers = buildSessionHeaders(session);

  const resp = await fetch(hostUrl("/api/v0/chat_session/create"), {
    method: "POST",
    headers,
    body: JSON.stringify({ agent: "chat" }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new DeepseekClientError(
      "backend-error",
      `Session create returned HTTP ${resp.status}.\n\n` +
        describeSessionIssue({
          type: "backend-error",
          message: `POST /api/v0/chat_session/create failed: ${resp.status} ${resp.statusText}`,
        }),
    );
  }

  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    throw new DeepseekClientError(
      "parse-error",
      `Session create did not return expected JSON.\n\n` +
        describeSessionIssue({
          type: "parse-error",
          message: "POST /api/v0/chat_session/create returned non-JSON.",
        }),
    );
  }

  const body = data as { code?: number; message?: string; data?: { id?: string | null } };
  if (body.code != null && body.code !== 0) {
    throw new DeepseekClientError(
      "backend-error",
      `Session create reported failure code ${body.code}: ${(body.message as string) ?? "no message"}.\n\n` +
        describeSessionIssue({
          type: "backend-error",
          message: `Session create failed: code ${body.code}`,
        }),
    );
  }

  const sessionId = readSessionId(data);

  if (!sessionId) {
    throw new DeepseekClientError(
      "parse-error",
      `Session create did not return a session id.\n\n` +
        describeSessionIssue({
          type: "parse-error",
          message: `Unexpected session create body: ${JSON.stringify(data).slice(0, 500)}`,
        }),
    );
  }
}

/** The session id lives at data.biz_data.id on the current API; keep
 *  data.id as a fallback in case the shape changes back. */
function readSessionId(data: unknown): string | undefined {
  const obj = data as {
    data?: { id?: string | null; biz_data?: { id?: string | null } };
  };
  const id =
    obj.data?.biz_data?.id ??
    obj.data?.id ??
    (obj.data as string | undefined) ??
    undefined;
  return typeof id === "string" && id !== "" ? id : undefined;
}

export async function lightHealthCheck(session: DeepseekSession): Promise<void> {
  const headers = buildSessionHeaders(session);

  const resp = await fetch(hostUrl("/api/v0/chat_session/create"), {
    method: "POST",
    headers,
    body: JSON.stringify({ agent: "chat" }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new DeepseekClientError(
      "backend-error",
      `Backend check returned HTTP ${resp.status}.\n\n` +
        describeSessionIssue({
          type: "backend-error",
          message: `chat.deepseek.com did not respond as expected: ${resp.status} ${resp.statusText}`,
        }),
    );
  }

  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    throw new DeepseekClientError(
      "parse-error",
      `Backend check returned non-JSON.\n\n` +
        describeSessionIssue({
          type: "parse-error",
          message: "chat.deepseek.com did not return expected JSON.",
        }),
    );
  }

  const body = data as { code?: number };
  if (body.code != null && body.code !== 0) {
    throw new DeepseekClientError(
      "backend-error",
      `Backend check reported failure code ${body.code}.\n\n` +
        describeSessionIssue({
          type: "backend-error",
          message: `chat.deepseek.com rejected the request: code ${body.code}`,
        }),
    );
  }
}

export type ChatRequest = {
  session: DeepseekSession;
  prompt: string;
  chat_session_id: string;
  parent_message_id?: string;
  model_type?: string;
  thinking_enabled?: boolean;
  search_enabled?: boolean;
};

export type ChatResult = {
  text: string;
  message_id?: string;
};

export async function createChatSession(session: DeepseekSession): Promise<string> {
  const headers = buildSessionHeaders(session);

  const resp = await fetch(hostUrl("/api/v0/chat_session/create"), {
    method: "POST",
    headers,
    body: JSON.stringify({ agent: "chat" }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new DeepseekClientError(
      "backend-error",
      `Failed to create chat session: HTTP ${resp.status}.\n\n` +
        describeSessionIssue({
          type: "backend-error",
          message: `POST /api/v0/chat_session/create failed: ${resp.status} ${resp.statusText}`,
        }),
    );
  }

  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    throw new DeepseekClientError(
      "parse-error",
      `Unexpected session create response.\n\n` +
        describeSessionIssue({
          type: "parse-error",
          message: "POST /api/v0/chat_session/create returned non-JSON.",
        }),
    );
  }

  const body = data as { code?: number; data?: { id?: string | null } };
  if (body.code != null && body.code !== 0) {
    throw new DeepseekClientError(
      "backend-error",
      `Session create failed (code ${body.code}).\n\n` +
        describeSessionIssue({
          type: "backend-error",
          message: `session create error code ${body.code}`,
        }),
    );
  }

  const id = readSessionId(data);
  if (!id) {
    throw new DeepseekClientError(
      "parse-error",
      `Session create response missing id.\n\n` +
        describeSessionIssue({
          type: "parse-error",
          message: `unexpected session create body: ${JSON.stringify(data).slice(0, 400)}`,
        }),
    );
  }

  return id;
}

type PowChallenge = {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  expire_at: number;
  signature: string;
  target_path: string;
};

async function fetchPowChallenge(
  session: DeepseekSession,
  targetPath: string,
): Promise<PowChallenge> {
  const headers = buildSessionHeaders(session);

  const resp = await fetch(hostUrl("/api/v0/chat/create_pow_challenge"), {
    method: "POST",
    headers,
    body: JSON.stringify({ target_path: targetPath }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new DeepseekClientError(
      "backend-error",
      `Failed to fetch pow challenge: HTTP ${resp.status}.\n\n` +
        describeSessionIssue({
          type: "backend-error",
          message: `POST /api/v0/chat/create_pow_challenge failed: ${resp.status} ${resp.statusText}`,
        }),
    );
  }

  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    throw new DeepseekClientError(
      "parse-error",
      `Pow challenge response is not JSON.\n\n` +
        describeSessionIssue({
          type: "parse-error",
          message: "POST /api/v0/chat/create_pow_challenge returned non-JSON.",
        }),
    );
  }

  const body = data as {
    code?: number;
    data?: { biz_data?: Record<string, unknown>; challenge?: Record<string, unknown> };
  };

  if (body.code != null && body.code !== 0) {
    throw new DeepseekClientError(
      "backend-error",
      `Pow challenge failed (code ${body.code}).\n\n` +
        describeSessionIssue({
          type: "backend-error",
          message: `pow challenge error code ${body.code}`,
        }),
    );
  }

  // Current shape nests the challenge at data.biz_data.challenge; keep
  // fallbacks for older flat shapes.
  const payload =
    (body.data as { biz_data?: { challenge?: Record<string, unknown> } } | undefined)?.biz_data
      ?.challenge ??
    body.data?.challenge ??
    (body.data as Record<string, unknown> | undefined);
  if (!payload) {
    throw new DeepseekClientError(
      "parse-error",
      `Pow challenge response missing data.\n\n` +
        describeSessionIssue({
          type: "parse-error",
          message: `unexpected pow challenge body: ${JSON.stringify(data).slice(0, 400)}`,
        }),
    );
  }

  const challenge = payload.challenge as string | undefined;
  const salt = payload.salt as string | undefined;
  const algorithm = payload.algorithm as string | undefined;
  const difficulty = Number(payload.difficulty ?? 0);
  const expire_at = Number(payload.expire_at ?? 0);
  const signature = payload.signature as string | undefined;
  const target_path = payload.target_path as string | undefined;

  if (!challenge || !salt || !algorithm || !signature || !target_path) {
    throw new DeepseekClientError(
      "parse-error",
      `Pow challenge missing required fields.\n\n` +
        describeSessionIssue({
          type: "parse-error",
          message: `required fields missing from pow challenge: ${JSON.stringify(payload).slice(0, 400)}`,
        }),
    );
  }

  return {
    algorithm: algorithm ?? "",
    challenge: challenge ?? "",
    salt: salt ?? "",
    difficulty: difficulty || 0,
    expire_at: expire_at || 0,
    signature: signature ?? "",
    target_path: target_path ?? "",
  };
}

async function solvePowWithWasm(
  wasmPath: string,
  algorithm: string,
  challenge: string,
  salt: string,
  expire_at: number,
  difficulty: number,
  signature: string,
  target_path: string,
): Promise<string> {
  let wasmBytes: Buffer;
  try {
    wasmBytes = await readFile(wasmPath);
  } catch (error) {
    throw new DeepseekClientError(
      "pow-error",
      `Cannot read pow wasm binary at ${wasmPath}.\n\n` +
        describeSessionIssue({
          type: "pow-error",
          message: `sha3_wasm_bg.wasm not found or unreadable: ${error instanceof Error ? error.message : String(error)}`,
        }),
    );
  }

  const wasmModule = await WebAssembly.compile(wasmBytes);
  const wasmInstance = await WebAssembly.instantiate(wasmModule, {});

  const wasmExports = wasmInstance.exports as Record<string, unknown>;
  const wasmMemoryRaw = wasmExports.memory;
  if (!(wasmMemoryRaw instanceof WebAssembly.Memory)) {
    throw new DeepseekClientError(
      "pow-error",
      `Pow wasm binary does not export a memory.\n\n` +
        describeSessionIssue({
          type: "pow-error",
          message: "The vendored sha3_wasm_bg.wasm may be outdated or from a different build.",
        }),
    );
  }
  const wasmMemory: WebAssembly.Memory = wasmMemoryRaw;

  const malloc = wasmExports.__wbindgen_export_0 as ((size: number, align: number) => number) | undefined;
  const realloc = wasmExports.__wbindgen_export_1 as
    | ((ptr: number, oldSize: number, newSize: number, align: number) => number)
    | undefined;
  const addStackPointer = wasmExports.__wbindgen_add_to_stack_pointer as
    | ((delta: number) => number)
    | undefined;
  const wasmSolve = wasmExports.wasm_solve as
    | ((
        retptr: number,
        challengePtr: number,
        challengeLen: number,
        prefixPtr: number,
        prefixLen: number,
        difficulty: number,
      ) => void)
    | undefined;

  if (
    typeof wasmSolve !== "function" ||
    typeof malloc !== "function" ||
    typeof realloc !== "function" ||
    typeof addStackPointer !== "function"
  ) {
    throw new DeepseekClientError(
      "pow-error",
      `Pow wasm binary is missing expected exports.\n\n` +
        describeSessionIssue({
          type: "pow-error",
          message: "The vendored sha3_wasm_bg.wasm may be outdated or from a different build.",
        }),
    );
  }

  const encoder = new TextEncoder();

  /**
   * Write a string into wasm memory using the wasm module's own malloc.
   * Returns (pointer, length). Re-acquires the heap view after allocation
   * because malloc may grow the wasm memory, detaching any prior views.
   */
  function writeStringToWasm(str: string): { ptr: number; len: number } {
    const bytes = encoder.encode(str);
    const ptr = malloc!(bytes.length, 1) >>> 0;
    const heap = new Uint8Array(wasmMemory!.buffer);
    heap.set(bytes, ptr);
    return { ptr, len: bytes.length };
  }

  const prefix = `${salt}_${expire_at}_`;
  const retptr = addStackPointer(-16);

  try {
    const ch = writeStringToWasm(challenge);
    const pf = writeStringToWasm(prefix);

    wasmSolve(retptr, ch.ptr, ch.len, pf.ptr, pf.len, difficulty);

    const dv = new DataView(wasmMemory.buffer as ArrayBuffer);
    const status = dv.getInt32(retptr + 0, true);
    const answer = dv.getFloat64(retptr + 8, true);

    // status === 0 means no solution found; non-zero means success
    if (status === 0) {
      throw new DeepseekClientError(
        "pow-error",
        `Pow wasm solve returned status 0 (no solution found).\n\n` +
          describeSessionIssue({
            type: "pow-error",
            message: `wasm_solve could not find a nonce that satisfies difficulty ${difficulty}.`,
          }),
      );
    }

    if (!Number.isFinite(answer)) {
      throw new DeepseekClientError(
        "pow-error",
        `Pow wasm solve produced an invalid answer.\n\n` +
          describeSessionIssue({
            type: "pow-error",
            message: "wasm_solve produced a non-finite answer.",
          }),
      );
    }

    const answerInt = Math.floor(answer);
    const payload = JSON.stringify({
      algorithm: algorithm ?? "",
      challenge: challenge ?? "",
      salt: salt ?? "",
      answer: answerInt,
      signature: signature ?? "",
      target_path: target_path ?? "",
    });

    return Buffer.from(payload, "utf8").toString("base64");
  } finally {
    addStackPointer(16);
  }
}

export async function signPow(
  session: DeepseekSession,
  targetPath: string,
  wasmPath: string,
): Promise<string> {
  const challenge = await fetchPowChallenge(session, targetPath);
  return solvePowWithWasm(
    wasmPath,
    challenge.algorithm,
    challenge.challenge,
    challenge.salt,
    challenge.expire_at,
    challenge.difficulty,
    challenge.signature,
    challenge.target_path,
  );
}

export async function chatCompletion(
  session: DeepseekSession,
  request: ChatRequest,
  wasmPath: string,
): Promise<ChatResult> {
  const headers = buildSessionHeaders(session);

  const powResponse = await signPow(session, "/api/v0/chat/completion", wasmPath);
  headers["x-ds-pow-response"] = powResponse;

  const body: Record<string, unknown> = {
    chat_session_id: request.chat_session_id,
    prompt: request.prompt,
    ref_file_ids: [],
    thinking_enabled: request.thinking_enabled ?? true,
    search_enabled: request.search_enabled ?? false,
  };

  if (request.parent_message_id) {
    // The API expects parent_message_id as a number (u32), not a string.
    body.parent_message_id = Number(request.parent_message_id) || request.parent_message_id;
  }
  if (request.model_type) {
    body.model_type = request.model_type;
  }

  const resp = await fetch(hostUrl("/api/v0/chat/completion"), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new DeepseekClientError(
      "backend-error",
      `chat completion failed: HTTP ${resp.status}.\n\n` +
        describeSessionIssue({
          type: "backend-error",
          message: `POST /api/v0/chat/completion failed: ${resp.status} ${resp.statusText}${text ? "\n" + text.slice(0, 400) : ""}`,
        }),
    );
  }

  const reader = resp.body?.getReader();
  if (!reader) {
    throw new DeepseekClientError(
      "parse-error",
      `chat completion response had no body.\n\n` +
        describeSessionIssue({
          type: "parse-error",
          message: "chat completion returned an empty body.",
        }),
    );
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let messageId = "";

  // The SSE stream uses a "pointer" model:
  //   {p: "response/content", o: "APPEND", v: "Hello"}  — select content, append
  //   {v: ", world"}                                       — append to current field
  //   {p: "response/status", v: "FINISHED"}               — set status
  let activeField = "";

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith(":")) return;

    if (trimmed.startsWith("event:")) return;

    if (trimmed.startsWith("data:")) {
      const payloadText = trimmed.slice(5).trim();
      if (payloadText === "[DONE]") return;

      let payload: unknown;
      try {
        payload = JSON.parse(payloadText);
      } catch {
        return;
      }

      const p = payload as Record<string, unknown>;

      // Update the active field pointer if present.
      if (typeof p.p === "string") {
        activeField = p.p;
      }

      // The value can appear in .v or .content or .response.
      const val = p.v;

      // Handle the initial full response object: {v: {response: {...}}}
      if (val != null && typeof val === "object" && !Array.isArray(val)) {
        const vObj = val as Record<string, unknown>;
        const resp = vObj.response as Record<string, unknown> | undefined;
        if (resp && typeof resp === "object") {
          const initialContent = resp.content;
          if (typeof initialContent === "string") fullText = initialContent;
          const mid = resp.message_id;
          if (typeof mid === "number") messageId = String(mid);
        }
      }

      // Handle string values — append to the appropriate field.
      if (typeof val === "string") {
        if (activeField === "response/content" || activeField === "") {
          fullText += val;
        }
        // thinking_content and other fields are intentionally ignored for now.
      }

      // Handle numeric values.
      if (typeof val === "number" && activeField === "response/message_id") {
        messageId = String(val);
      }

      // Also accept legacy fragment format: {response: {fragments: [...]}}
      const responseAny = p.response as Record<string, unknown> | undefined;
      if (responseAny && typeof responseAny === "object") {
        const fragments = responseAny.fragments;
        if (Array.isArray(fragments)) {
          for (const fragment of fragments) {
            const frag = fragment as Record<string, unknown>;
            const t = frag.t as string | undefined;
            const c = frag.c as string | undefined;
            if (typeof c === "string") {
              if (t === "snapshot") fullText = c;
              else fullText += c;
            }
          }
        }
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(line);
        idx = buffer.indexOf("\n");
      }
    }

    if (buffer.length > 0) {
      handleLine(buffer);
    }
  } finally {
    try {
      reader.cancel();
    } catch {
      // best effort
    }
  }

  return {
    text: fullText,
    message_id: messageId || undefined,
  };
}

export async function runChat(
  session: DeepseekSession,
  request: ChatRequest,
  wasmPath: string,
): Promise<ChatResult> {
  const chatSessionId = request.chat_session_id;
  const parentMessageId = request.parent_message_id;

  return chatCompletion(session, { ...request, chat_session_id: chatSessionId }, wasmPath);
}

export async function saveSessionSnapshot(
  session: DeepseekSession,
  filePath: string,
): Promise<void> {
  const snapshot: DeepseekSessionFile = {
    ...session,
    captured_at: new Date().toISOString(),
    max_age_ms: DEFAULT_SESSION_MAX_AGE_MS,
  };
  await writeFile(filePath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
}

export const DEFAULT_POW_WASM_NAME = "sha3_wasm_bg.wasm";

export function resolvePowWasmPath(): string {
  const envPath = process.env["DEEPSEEK_POW_WASM_PATH"];
  if (envPath != null && envPath.trim() !== "") {
    return path.resolve(process.cwd(), envPath);
  }
  return path.resolve(process.cwd(), DEFAULT_POW_WASM_NAME);
}
