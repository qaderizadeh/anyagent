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

/** The normalized session the rest of the code works with. */
export type DeepseekSession = {
  token: string;
  cookies: Record<string, string>;
  user_agent: string;
  client_headers?: Record<string, string>;
};

/**
 * What a session file (or DEEPSEEK_SESSION_JSON) may contain.
 *
 * The simplest capture is the two headers of any chat.deepseek.com request
 * (e.g. POST /api/v0/chat/create_pow_challenge in the browser's network tab):
 *
 *   { "authorization": "Bearer eyJ...", "cookie": "ds_session_id=...; ..." }
 *
 * `token` is accepted as an alias for `authorization`, and `cookies` for
 * `cookie`, so header-style and older token-plus-map files both keep working.
 * `cookies` may itself be a name→value map instead of a raw header string.
 */
export type DeepseekSessionInput = {
  token?: string;
  authorization?: string;
  cookies?: Record<string, string> | string;
  cookie?: string;
  user_agent?: string;
  client_headers?: Record<string, string>;
  captured_at?: string | null;
  max_age_ms?: number;
};

export type DeepseekSessionFile = DeepseekSession & {
  captured_at?: string | null;
  max_age_ms?: number;
};

export type DeepseekError = {
  type:
    | "invalid-session"
    | "backend-error"
    | "pow-error"
    | "parse-error"
    /** Transport-level failure or a 429/5xx: worth retrying. */
    | "network"
    | "unknown";
  message: string;
};

export class DeepseekClientError extends Error {
  readonly kind: DeepseekError["type"];
  /** DeepSeek application-level error code (biz_code) when the backend
   *  reported one. Lets callers recover from a stale session/message
   *  linkage instead of failing the whole conversation. */
  readonly bizCode?: number;
  constructor(
    kind: DeepseekError["type"],
    message: string,
    options: { bizCode?: number } = {},
  ) {
    super(message);
    this.name = "DeepseekClientError";
    this.kind = kind;
    this.bizCode = options.bizCode;
  }
}

/**
 * Application-level codes that mean our cached session linkage is stale, not
 * that the request itself was wrong:
 *   - 1  invalid chat session id  — the chat was deleted/expired on the web side
 *   - 26 invalid message id       — the parent message no longer exists (e.g.
 *                                   it came from a reply that never completed)
 * Both are recoverable: continue in the same session without a parent, or
 * create a fresh session, in either case replaying the header and history.
 */
export const BIZ_CODE_INVALID_CHAT_SESSION = 1;
export const BIZ_CODE_INVALID_MESSAGE_ID = 26;

/** Extract the biz_code from a non-streaming completion body, if present. */
export function completionBodyBizCode(body: string): number | undefined {
  try {
    const root = JSON.parse(body) as {
      data?: { biz_code?: unknown };
      biz_code?: unknown;
    };
    const code = root?.data?.biz_code ?? root?.biz_code;
    return typeof code === "number" ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How long a captured session file is considered "fresh".
 *
 * This is only a hint for a warning: DeepSeek's web auth token lives far
 * longer than the old 6-hour default (a session captured a day earlier still
 * works). The backend is the real authority — if the token is actually dead,
 * the verification/health request fails with a clear message. Keeping a very
 * long window here avoids blocking startup for no reason.
 */
const DEFAULT_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function envPathOrJson(
  pathEnv: string,
  jsonEnv: string,
  filePath: string,
): DeepseekSessionInput | null {
  const jsonEnvValue = process.env[jsonEnv];
  if (jsonEnvValue != null && jsonEnvValue.trim() !== "") {
    try {
      return JSON.parse(jsonEnvValue) as DeepseekSessionInput;
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
      return JSON.parse(raw) as DeepseekSessionInput;
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
    return JSON.parse(raw) as DeepseekSessionInput;
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

/** Path portion of a URL, for error messages that must never leak a token. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * A bare "fetch failed" from undici tells the user nothing: the real reason
 * (DNS, connection reset, TLS, timeout) hides in error.cause. Surface it.
 */
function describeTransportError(url: string, error: unknown): string {
  const err = error as { message?: string; cause?: { code?: string; message?: string } };
  const cause = err?.cause;
  const detail = [cause?.code, cause?.message ?? err?.message]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(": ");
  return `Cannot reach chat.deepseek.com (${pathOf(url)})${detail ? `: ${detail}` : "."}`;
}

/**
 * fetch() with transport failures turned into a clear, retryable error, and
 * 429/5xx treated as transient rather than as a hard failure.
 */
async function httpFetch(url: string, init: RequestInit): Promise<Response> {
  let resp: Response;
  try {
    resp = await fetch(url, init);
  } catch (error) {
    throw new DeepseekClientError("network", describeTransportError(url, error));
  }

  if (resp.status === 429 || resp.status >= 500) {
    throw new DeepseekClientError(
      "network",
      `chat.deepseek.com returned HTTP ${resp.status} ${resp.statusText} for ${pathOf(url)}.`,
    );
  }
  return resp;
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
      "Simplest shape - copy the two request headers from your browser:\n" +
      JSON.stringify(
        {
          authorization: "Bearer <your token>",
          cookie: "ds_session_id=<...>; ...",
          user_agent: "Mozilla/5.0 ... Firefox/... Safari/...",
          captured_at: new Date().toISOString(),
        },
        null,
        2,
      ) +
      "\n" +
      "The older form is still accepted: a \"token\" plus a \"cookies\" map.\n" +
      "\n" +
      "How to create one:\n" +
      "1. Open https://chat.deepseek.com and sign in.\n" +
      "2. Open DevTools -> Network and click any request to /api/v0/...\n" +
      "   (create_pow_challenge is a good pick).\n" +
      "3. Under Request Headers, copy the values of `authorization` and\n" +
      "   `cookie` into the file above. The rest is optional.\n" +
      "4. Paste it into the session file, or run again with the JSON in\n" +
      "   DEEPSEEK_SESSION_JSON.\n" +
      "\n" +
      raw.message
    );
  }

  if (raw.type === "backend-error") {
    // The completion-body helper already yields a complete, actionable
    // message for application-level failures (a mute is not a session or
    // transport problem, so the generic advice below would be misleading).
    if (/DeepSeek has muted this account|DeepSeek rejected/.test(raw.message)) {
      return raw.message;
    }
    // A gateway-level rejection means the request never reached the chat app.
    // It shows up as HTTP 4xx, typically 422 with FastAPI's
    // {"detail":[{"loc":"body"}]} body, and is about anti-bot state, not
    // about the login being expired.
    if (/HTTP 4\d\d/.test(raw.message) || /"detail"/.test(raw.message)) {
      return (
        "chat.deepseek.com rejected the request before it reached the chat app.\n" +
        "\n" +
        raw.message +
        "\n" +
        "\n" +
        "This is a gateway/anti-bot rejection, not an expired login. It usually\n" +
        "means the session's anti-bot cookie went stale, or DeepSeek is\n" +
        "throttling this connection after a burst of requests.\n" +
        "\n" +
        "Wait a few minutes and try again. If it persists, re-capture both\n" +
        "headers from the browser (the aws-waf-token cookie matters)."
      );
    }
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

  if (raw.type === "network") {
    return (
      "Could not reach chat.deepseek.com.\n" +
      "\n" +
      raw.message +
      "\n" +
      "\n" +
      "Usually this is a temporary network or DNS problem, or DeepSeek\n" +
      "momentarily refusing traffic. The agent retries these by itself, so you\n" +
      "only see it when they keep failing.\n" +
      "\n" +
      "Check your connection and try the task again."
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

/**
 * The freshness window used for the (advisory) staleness warning.
 *
 * It is a property of the tool, not of the capture file: older files carry a
 * now-known-too-short 6-hour `max_age_ms` value, and honouring it would nag on
 * every startup even though the token still works. Override with
 * DEEPSEEK_SESSION_MAX_AGE_MS if you want a different window.
 */
function effectiveSessionMaxAgeMs(): number {
  const raw = process.env["DEEPSEEK_SESSION_MAX_AGE_MS"];
  if (raw != null && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_SESSION_MAX_AGE_MS;
}

function formatDuration(ms: number): string {
  if (ms >= 86_400_000) return `${(ms / 86_400_000).toFixed(1)} days`;
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)} hours`;
  return `${Math.round(ms / 60_000)} minutes`;
}

export function sessionFreshnessOk(
  session: DeepseekSessionFile | null,
): boolean {
  if (!session) return false;
  const rawCaptured = session.captured_at;
  const captured = rawCaptured ? new Date(rawCaptured) : null;
  if (!captured || isNaN(captured.getTime())) return true;
  return Date.now() - captured.getTime() <= effectiveSessionMaxAgeMs();
}

/**
 * A non-fatal warning when the session file is older than its freshness
 * window. The agent keeps running either way: the backend decides whether
 * the token still works. Returns null when there is nothing to say.
 */
export function sessionAgeWarning(
  session: DeepseekSessionFile | null,
): string | null {
  if (!session) return null;
  const captured = session.captured_at ? new Date(session.captured_at) : null;
  if (!captured || isNaN(captured.getTime())) return null;
  const maxAge = effectiveSessionMaxAgeMs();
  const age = Date.now() - captured.getTime();
  if (age <= maxAge) return null;
  return (
    `The saved DeepSeek session is ${formatDuration(age)} old (freshness window ` +
    `${formatDuration(maxAge)}). Continuing anyway — if requests start failing, ` +
    "re-capture it from chat.deepseek.com."
  );
}

const BEARER_PREFIX = "Bearer ";

const PLACEHOLDER_TOKEN = "your-session-token";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Extract the bare token from any captured form:
 *   - the raw value
 *   - the localStorage wrapper {"value":"<token>","__version":"0"}
 *   - a complete header value ("Bearer <token>")
 *
 * Idempotent, so saving a normalized session never doubles the prefix.
 */
export function normalizeToken(raw: string): string {
  let value = (raw ?? "").trim();
  const match = /^bearer\s+(.*)$/i.exec(value);
  if (match) value = match[1].trim();
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && typeof parsed.value === "string") {
      return parsed.value;
    }
  } catch {
    // not JSON — already the raw token
  }
  return value;
}

/** The full Authorization header value (empty string when there is no token). */
export function normalizeAuthorization(raw: string): string {
  const value = normalizeToken(raw);
  return value === "" ? "" : `${BEARER_PREFIX}${value}`;
}

/**
 * Build the Cookie header value from a captured cookie.
 *
 * Accepts a raw "ds_session_id=...; ..." header string (what you copy out of
 * the browser's network tab) or a name→value map. A JSON-encoded map inside a
 * string is also accepted.
 */
export function normalizeCookieHeader(raw: unknown): string {
  if (raw == null) return "";

  const fromMap = (map: Record<string, unknown>): string =>
    Object.entries(map)
      .filter(([key, value]) => key !== "" && value != null && String(value) !== "")
      .map(([key, value]) => `${key}=${String(value)}`)
      .join("; ");

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return "";
    if (trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return fromMap(parsed as Record<string, unknown>);
        }
      } catch {
        // Not JSON — treat it as a raw header value.
      }
    }
    return trimmed;
  }

  if (typeof raw === "object" && !Array.isArray(raw)) {
    return fromMap(raw as Record<string, unknown>);
  }

  return "";
}

/**
 * Canonicalize any accepted session shape into the runtime form. This is what
 * makes the simple "copy the authorization and cookie headers" file work.
 */
export function normalizeSession(raw: DeepseekSessionInput): DeepseekSessionFile {
  const token = normalizeToken(raw.token ?? raw.authorization ?? "");
  const cookie = normalizeCookieHeader(raw.cookies ?? raw.cookie ?? "");
  const cookies: Record<string, string> = {};
  for (const part of cookie.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key !== "") cookies[key] = value;
  }

  return {
    token,
    cookies,
    user_agent: (raw.user_agent ?? "").trim() || DEFAULT_USER_AGENT,
    client_headers: raw.client_headers,
    captured_at: raw.captured_at ?? null,
    max_age_ms: raw.max_age_ms,
  };
}

export function buildSessionHeaders(session: DeepseekSession): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": session.user_agent,
    Origin: "https://chat.deepseek.com",
    Referer: "https://chat.deepseek.com/",
    Accept: "text/event-stream, application/json, */*",
    "Content-Type": "application/json",
  };

  const authorization = normalizeAuthorization(session.token ?? "");
  if (authorization !== "") {
    headers["Authorization"] = authorization;
  }

  const cookie = normalizeCookieHeader(session.cookies);
  if (cookie !== "") {
    headers["Cookie"] = cookie;
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

  // Accept every capture style (raw header values, a cookie map, an
  // Authorization value that already starts with "Bearer ") and canonicalize.
  const session = normalizeSession(raw);

  // A stale session file is not an error: DeepSeek tokens outlive the
  // freshness window, so we warn (via sessionAgeWarning) and let the backend
  // decide. Blocking startup here was a false negative in practice.

  // The shipped placeholder is not a real session: guide the user to
  // capture one instead of failing against the backend.
  if (session.token === PLACEHOLDER_TOKEN) {
    throw new DeepseekClientError(
      "invalid-session",
      `The session file still contains the placeholder values.\n\n` +
        describeSessionIssue({
          type: "invalid-session",
          message: "Replace the placeholder authorization and cookie with your real DeepSeek session.",
        }),
    );
  }

  if (session.token === "" && Object.keys(session.cookies).length === 0) {
    throw new DeepseekClientError(
      "invalid-session",
      `Session file exists but has no authorization or cookie.\n\n` +
        describeSessionIssue({
          type: "invalid-session",
          message: "Fill in the authorization and cookie values in the session file.",
        }),
    );
  }

  return session;
}

export async function verifySession(session: DeepseekSession): Promise<void> {
  const headers = buildSessionHeaders(session);

  const resp = await httpFetch(hostUrl("/api/v0/chat_session/create"), {
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

  const resp = await httpFetch(hostUrl("/api/v0/chat_session/create"), {
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

/**
 * Turn a non-SSE JSON body from /chat/completion into a readable error.
 *
 * The endpoint normally streams SSE. When it instead returns a plain JSON
 * envelope it is an application-level failure: the old code fed that body to
 * the SSE parser, which found no events and returned an empty reply — so a
 * blocked/muted account looked like a silent, empty model answer. Surface it
 * instead.
 */
export function describeCompletionBody(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return `chat completion returned a non-streaming response: ${body.slice(0, 400)}`;
  }

  const root = parsed as {
    code?: unknown;
    msg?: unknown;
    message?: unknown;
    data?: unknown;
  };
  const data = (root.data ?? {}) as {
    biz_code?: unknown;
    biz_msg?: unknown;
    biz_data?: { is_muted?: unknown; mute_until?: unknown };
  };
  const bizData = data.biz_data ?? {};
  const bizCode = typeof data.biz_code === "number" ? data.biz_code : undefined;
  const bizMsg =
    typeof data.biz_msg === "string" && data.biz_msg !== "" ? data.biz_msg : undefined;

  if (bizData.is_muted === 1 || bizData.is_muted === true) {
    const until =
      typeof bizData.mute_until === "number"
        ? ` until ${new Date(bizData.mute_until * 1000).toISOString()}`
        : "";
    return (
      `DeepSeek has muted this account${until} (biz_code ${bizCode ?? 5}: ${bizMsg ?? "user is muted"}).\n` +
      "\n" +
      "This is a DeepSeek-side restriction on automated use, not a bug in the agent.\n" +
      "Wait for the mute to expire, and avoid firing many requests in a burst."
    );
  }

  if (bizCode != null && bizCode !== 0) {
    return `DeepSeek rejected the completion (biz_code ${bizCode}: ${bizMsg ?? "no message"}).`;
  }
  if (typeof root.code === "number" && root.code !== 0) {
    const msg = typeof root.msg === "string" ? root.msg : "no message";
    return `DeepSeek rejected the completion (code ${root.code}: ${msg}).`;
  }

  return `chat completion returned an unexpected non-streaming response: ${body.slice(0, 400)}`;
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

  const resp = await httpFetch(hostUrl("/api/v0/chat_session/create"), {
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

  const resp = await httpFetch(hostUrl("/api/v0/chat/create_pow_challenge"), {
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

  const resp = await httpFetch(hostUrl("/api/v0/chat/completion"), {
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

  // A streaming reply is text/event-stream. Anything else (notably a JSON
  // envelope like {code:0,data:{biz_code:5,biz_msg:"user is muted"}}) is a
  // backend-level failure that must be reported, never parsed as an empty
  // stream of events.
  const contentType = resp.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const body = await resp.text().catch(() => "");
    throw new DeepseekClientError("backend-error", describeCompletionBody(body), {
      bizCode: completionBodyBizCode(body),
    });
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
  let currentEvent = "";

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith(":")) return;

    if (trimmed.startsWith("event:")) {
      currentEvent = trimmed.slice(6).trim();
      return;
    }

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

      // Application-level failures can also arrive as an in-stream payload;
      // never let one masquerade as an empty answer.
      const pCode = p.code;
      const pBizCode = p.biz_code;
      if (
        (typeof pCode === "number" && pCode !== 0) ||
        (typeof pBizCode === "number" && pBizCode !== 0)
      ) {
        throw new DeepseekClientError("backend-error", describeCompletionBody(payloadText), {
          bizCode: completionBodyBizCode(payloadText),
        });
      }

      // The `ready` event carries the assistant message id directly:
      //   event: ready
      //   data: {"request_message_id":1,"response_message_id":2,...}
      // It is the most reliable source of the id, and the resume marker
      // depends on it — a missed id silently breaks session continuity.
      if (currentEvent === "ready" && p.response_message_id != null) {
        const rid = p.response_message_id;
        if (typeof rid === "number" || (typeof rid === "string" && rid !== "")) {
          messageId = String(rid);
        }
      }
      currentEvent = "";

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
          if (typeof mid === "number" || (typeof mid === "string" && mid !== "")) {
            messageId = String(mid);
          }
        }
      }

      // Handle string values — append to the appropriate field.
      if (typeof val === "string") {
        if (activeField === "response/content" || activeField === "") {
          fullText += val;
        }
        // thinking_content and other fields are intentionally ignored for now.
      }

      // Handle explicit message id assignments (number or string).
      if (
        (typeof val === "number" || (typeof val === "string" && val !== "")) &&
        activeField === "response/message_id"
      ) {
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
