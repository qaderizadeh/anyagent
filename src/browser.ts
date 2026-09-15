/**
 * DeepSeek transport, driven through a real browser.
 *
 * The agent never calls chat.deepseek.com itself. It drives the site in a
 * Chromium window with a persistent profile, the way a person would: it types
 * the prompt into the composer, presses Enter, and reads DeepSeek's own
 * /chat/completion response off the wire. No credentials are stored by this
 * project - the login lives in the browser profile.
 *
 * Requests therefore carry a real browser fingerprint and a human pace instead
 * of a script's. The direct-HTTP version is kept on branch `direct-api` and
 * tag `v1.0.0`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type BrowserContext, type Locator, type Page, type Response } from "playwright";

const HOST = "https://chat.deepseek.com";
const COMPLETION_PATH = "/api/v0/chat/completion";
/** Chat ids in the address bar: /a/chat/s/<uuid> */
const CHAT_URL = /\/a\/chat\/s\/([0-9a-z-]{8,})/i;

const LOGIN_TIMEOUT_MS = intEnv("ANYAGENT_LOGIN_TIMEOUT_MS", 300_000);
const COMPLETION_TIMEOUT_MS = intEnv("ANYAGENT_COMPLETION_TIMEOUT_MS", 300_000);
/** A pause before each prompt, so turns are not fired back to back. */
const PACE_MS = intEnv("ANYAGENT_PACE_MS", 800);

export type ChatSession = {
  id: string;
  title: string;
  /** Unix seconds, as reported by the backend. */
  updatedAt: number;
  lastMessageId: number;
};

export type HistoryMessage = {
  id: number;
  role: string;
  content: string;
};

export type Completion = {
  text: string;
  messageId?: string;
};

/** Deep thinking and web search, the two composer switches. */
export function modes(): { thinking: boolean; search: boolean } {
  return {
    thinking: boolEnv("DEEPSEEK_THINKING_ENABLED", true),
    search: boolEnv("DEEPSEEK_SEARCH_ENABLED", false),
  };
}

/** Where the persistent browser profile lives - this is the login. */
export function profileDir(): string {
  const configured = (process.env["ANYAGENT_PROFILE_DIR"] ?? "").trim();
  return configured === "" ? path.join(os.homedir(), ".anyagent", "browser") : path.resolve(configured);
}

function intEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Race work against a deadline without leaving a timer hanging. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work.catch(() => null),
      new Promise<null>((done) => {
        timer = setTimeout(() => done(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class Browser {
  /** Newest stored message id, so a recovered answer can be told from an older one. */
  private lastSeenId = 0;
  /** What DeepSeek posted lately, for the "the turn never went out" error. */
  private readonly posted: string[] = [];

  private constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/api/v0/")) {
        this.posted.push(new URL(request.url()).pathname);
        if (this.posted.length > 8) this.posted.shift();
      }
    });
  }

  /** Open the window, load the site, and wait until the profile is signed in. */
  static async open(log: (text: string) => void = () => {}): Promise<Browser> {
    const dir = profileDir();
    fs.mkdirSync(dir, { recursive: true });
    const headless = boolEnv("ANYAGENT_HEADLESS", false);
    const executable = (process.env["ANYAGENT_BROWSER_PATH"] ?? "").trim();

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(dir, {
        headless,
        executablePath: executable === "" ? undefined : executable,
        viewport: null,
        locale: "en-US",
        // Chromium announces automated sessions by default; a person's does not.
        args: ["--disable-blink-features=AutomationControlled"],
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      throw new Error(
        `Could not start Chromium: ${reason}\n\n` +
          "Install the browser once with:  npx playwright install chromium\n" +
          "If another window is already using the profile, close it and try again.\n" +
          `Profile: ${dir}`,
      );
    }

    const page = context.pages()[0] ?? (await context.newPage());
    const browser = new Browser(context, page);
    await browser.installModes();
    await page.goto(`${HOST}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await browser.ensureSignedIn(log);
    return browser;
  }

  /**
   * Deep thinking and web search are per-message switches in the composer. The
   * site sends them as fields of the completion request, so set them there
   * rather than clicking a button whose markup we would have to guess at.
   */
  private async installModes(): Promise<void> {
    const { thinking, search } = modes();
    await this.page.route(`**${COMPLETION_PATH}`, async (route) => {
      const request = route.request();
      let body: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(request.postData() ?? "{}");
        if (parsed !== null && typeof parsed === "object") body = parsed as Record<string, unknown>;
      } catch {
        body = null;
      }
      if (body === null) {
        await route.continue();
        return;
      }
      body["thinking_enabled"] = thinking;
      body["search_enabled"] = search;
      await route.continue({ postData: JSON.stringify(body) });
    });
  }

  private async ensureSignedIn(log: (text: string) => void): Promise<void> {
    if (await this.signedIn(15_000)) return;
    if (boolEnv("ANYAGENT_HEADLESS", false)) {
      throw new Error(
        "This browser profile is not signed in, and the window is headless.\n" +
          "Run once without ANYAGENT_HEADLESS to sign in, or point ANYAGENT_PROFILE_DIR " +
          "at a profile that is already signed in.",
      );
    }
    log("Not signed in. Sign in at chat.deepseek.com in the browser window - anyagent carries on by itself.");
    if (!(await this.signedIn(LOGIN_TIMEOUT_MS))) {
      throw new Error(
        `Still not signed in after ${Math.round(LOGIN_TIMEOUT_MS / 1000)}s. Run anyagent again when you are ready.`,
      );
    }
  }

  /** Signed in means the message box is on the page. */
  private async signedIn(timeout: number): Promise<boolean> {
    try {
      await this.composer().waitFor({ state: "visible", timeout });
      return true;
    } catch {
      return false;
    }
  }

  /** The message box: current DeepSeek uses a textarea, older builds a div. */
  private composer(): Locator {
    return this.page.locator("#chat-input, textarea, [contenteditable='true']").filter({ visible: true }).last();
  }

  /** One turn: type the prompt, send it, and read DeepSeek's own response. */
  async ask(prompt: string): Promise<Completion> {
    // The response has to be watched for before it is sent, or it is missed.
    const pending = this.waitForCompletion(20_000);
    await this.type(prompt);
    let started = await pending;
    if (started === null) {
      await this.clickSend();
      started = await this.waitForCompletion(COMPLETION_TIMEOUT_MS);
    }
    if (started === null) {
      const seen = [...new Set(this.posted)];
      throw new Error(
        `DeepSeek never sent ${COMPLETION_PATH}, so this turn did not go out.\n` +
          (seen.length > 0 ? `Requests seen: ${seen.join(", ")}` : "No request was seen at all.") +
          "\nSend one message by hand in the browser window to check it goes through.",
      );
    }

    const body = await withTimeout(started.body(), COMPLETION_TIMEOUT_MS);
    const raw = body == null ? "" : body.toString("utf8");
    const reply = raw === "" ? null : parseStream(raw);

    if (reply !== null && reply.text.trim() !== "") {
      if (reply.messageId) this.lastSeenId = Number(reply.messageId) || this.lastSeenId;
      return reply;
    }

    // DeepSeek keeps generating and stores the answer even when the stream
    // breaks, so look there before reporting an empty turn.
    return (await this.recoverAnswer()) ?? reply ?? { text: "" };
  }

  private waitForCompletion(ms: number): Promise<Response | null> {
    return this.page
      .waitForResponse(
        (response) =>
          response.request().method() === "POST" && response.url().includes(COMPLETION_PATH),
        { timeout: ms },
      )
      .catch(() => null);
  }

  private async type(prompt: string): Promise<void> {
    if (PACE_MS > 0) await sleep(PACE_MS / 2 + Math.random() * PACE_MS);
    const composer = this.composer();
    await composer.click({ timeout: 15_000 });
    try {
      await composer.fill(prompt);
    } catch {
      // contenteditable composers do not accept fill
      await this.page.keyboard.insertText(prompt);
    }
    await this.page.keyboard.press("Enter");
  }

  /** The send button, for builds where Enter does not submit the composer. */
  private async clickSend(): Promise<void> {
    const send = this.page
      .locator("button[aria-label*='end' i], button[type='submit'], button:has-text('Send')")
      .filter({ visible: true })
      .last();
    await send.click({ timeout: 5_000 }).catch(() => {});
  }

  /** The answer DeepSeek stored for this turn, when the stream did not carry it. */
  private async recoverAnswer(): Promise<Completion | null> {
    for (let attempt = 0; attempt < 15; attempt++) {
      await sleep(2_000);
      const message = await this.lastAssistant().catch(() => null);
      if (message === null) {
        // No message for this turn at all: it was never stored, so stop early.
        if (attempt >= 2) return null;
        continue;
      }
      if (message.content.trim() !== "") return { text: message.content, messageId: String(message.id) };
    }
    return null;
  }

  private async lastAssistant(): Promise<HistoryMessage | null> {
    const turn = (await this.history()).filter(
      (message) => message.role === "ASSISTANT" && message.id > this.lastSeenId,
    );
    return turn.length > 0 ? turn[turn.length - 1]! : null;
  }

  /** The chat currently open in the window, if any. */
  currentChatId(): string {
    return CHAT_URL.exec(this.page.url())?.[1] ?? "";
  }

  /** Start a fresh chat. It has no id until the first message is stored. */
  async newSession(): Promise<void> {
    await this.page.goto(`${HOST}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (!(await this.signedIn(30_000))) throw new Error("The new-chat page did not load. Are you signed in?");
    this.lastSeenId = 0;
  }

  /** Open an existing chat by id. */
  async openSession(id: string): Promise<void> {
    await this.page.goto(`${HOST}/a/chat/s/${encodeURIComponent(id)}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    if (!(await this.signedIn(30_000))) throw new Error("The chat page did not load. Are you signed in?");
    if (this.currentChatId() !== id) {
      throw new Error(`chat.deepseek.com did not open chat ${id}; the window is at ${this.page.url()}`);
    }
    const messages = await this.history().catch(() => []);
    this.lastSeenId = messages.reduce((max, message) => Math.max(max, message.id), 0);
  }

  /** The account's chat sessions - the same list the sidebar shows. */
  async listSessions(count = 20): Promise<ChatSession[]> {
    // The backend rejects count < 2 with ILLEGAL_COUNT.
    const body = await this.api(`/api/v0/chat_session/fetch_page?count=${Math.max(2, count)}`);
    const data = bizData(body);
    const list = Array.isArray(data["chat_sessions"]) ? data["chat_sessions"] : [];
    return list
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
      .map((item) => ({
        id: String(item["id"] ?? ""),
        title: String(item["title"] ?? "").trim() || "(untitled)",
        updatedAt: Number(item["updated_at"] ?? 0),
        lastMessageId: Number(item["current_message_id"] ?? 0),
      }))
      .filter((item) => item.id !== "");
  }

  private async history(): Promise<HistoryMessage[]> {
    const chatId = this.currentChatId();
    if (chatId === "") return [];
    const data = bizData(
      await this.api(`/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(chatId)}`),
    );
    const list = Array.isArray(data["chat_messages"]) ? data["chat_messages"] : [];
    return list
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
      .map((item) => ({
        id: Number(item["message_id"] ?? 0),
        role: String(item["role"] ?? ""),
        content: String(item["content"] ?? ""),
      }));
  }

  /**
   * Reads go through the page's own fetch, so they carry this browser's
   * cookies and fingerprint - and never the completion path, which is always
   * typed by hand.
   */
  private async api(pathname: string): Promise<string> {
    const token = await this.token();
    const result = await this.page.evaluate(
      async ([url, bearer]: [string, string]) => {
        const response = await fetch(url, {
          headers: bearer === "" ? {} : { authorization: `Bearer ${bearer}` },
          credentials: "include",
        });
        return { status: response.status, body: await response.text() };
      },
      [HOST + pathname, token] as [string, string],
    );
    if (result.status !== 200) {
      throw new Error(
        `chat.deepseek.com returned HTTP ${result.status} for ${pathname}\n${result.body.slice(0, 200)}`,
      );
    }
    return result.body;
  }

  /** The bearer token the site keeps in local storage. */
  private async token(): Promise<string> {
    return this.page.evaluate(() => {
      const store = (
        globalThis as unknown as {
          localStorage: { length: number; key(index: number): string | null; getItem(k: string): string | null };
        }
      ).localStorage;
      const unwrap = (value: string): string => {
        try {
          const parsed: unknown = JSON.parse(value);
          if (parsed !== null && typeof parsed === "object") {
            const inner = (parsed as Record<string, unknown>)["value"];
            if (typeof inner === "string") return inner;
          }
        } catch {
          // not wrapped - use it as it is
        }
        return value;
      };
      const named = store.getItem("userToken");
      if (named !== null && named !== "") return unwrap(named);
      for (let index = 0; index < store.length; index++) {
        const key = store.key(index);
        if (key === null) continue;
        const candidate = unwrap(store.getItem(key) ?? "");
        if (/^[A-Za-z0-9._-]{40,}$/.test(candidate)) return candidate;
      }
      return "";
    });
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* responses                                                           */
/* ------------------------------------------------------------------ */

function json(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // fall through to the error below
  }
  throw new Error(`Unexpected response from chat.deepseek.com:\n${text.slice(0, 200)}`);
}

/** Unwrap the {"code":0,"data":{"biz_data":{...}}} envelope. */
function bizData(text: string): Record<string, unknown> {
  const root = json(text);
  const outer = root["code"];
  if (typeof outer === "number" && outer !== 0) {
    throw new Error(`chat.deepseek.com rejected the request (code ${outer}: ${String(root["msg"] ?? "")})`);
  }
  const data = (root["data"] ?? {}) as Record<string, unknown>;
  const inner = data["biz_data"];
  return (inner !== null && typeof inner === "object" ? inner : data) as Record<string, unknown>;
}

/**
 * Read the streamed reply.
 *
 * The payload is a pointer stream:
 *   {"p":"response/content","o":"APPEND","v":"Hello"}   append to the answer
 *   {"p":"response/status","v":"FINISHED"}              turn finished
 * `event: ready` carries the assistant message id.
 */
function parseStream(raw: string): Completion {
  let text = "";
  let messageId = "";
  let event = "";
  let field = "";

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith(":")) continue;
    if (trimmed.startsWith("event:")) {
      event = trimmed.slice(6).trim();
      continue;
    }
    if (!trimmed.startsWith("data:")) continue;

    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") continue;

    let item: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed === null || typeof parsed !== "object") continue;
      item = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    // In-stream refusals must surface, not look like an empty reply.
    const inner = (item["data"] ?? {}) as Record<string, unknown>;
    const outerCode = item["code"];
    const bizCode = item["biz_code"] ?? inner["biz_code"];
    if ((typeof outerCode === "number" && outerCode !== 0) || (typeof bizCode === "number" && bizCode !== 0)) {
      const code = typeof bizCode === "number" ? bizCode : outerCode;
      throw new Error(
        `chat.deepseek.com refused the turn (biz_code ${String(code)}: ` +
          `${String(item["biz_msg"] ?? inner["biz_msg"] ?? "")})`,
      );
    }

    if (event === "ready" && item["response_message_id"] != null) {
      messageId = String(item["response_message_id"]);
    }
    event = "";

    if (typeof item["p"] === "string") field = item["p"];

    const value = item["v"];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const full = (value as Record<string, unknown>)["response"];
      if (full !== null && typeof full === "object") {
        const response = full as Record<string, unknown>;
        if (typeof response["content"] === "string") text = response["content"];
        if (response["message_id"] != null) messageId = String(response["message_id"]);
      }
    } else if (typeof value === "string" && (field === "response/content" || field === "")) {
      text += value;
    }

    if (field === "response/message_id" && (typeof value === "number" || typeof value === "string")) {
      messageId = String(value);
    }
  }

  return { text, messageId: messageId || undefined };
}
