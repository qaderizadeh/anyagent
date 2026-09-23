/**
 * DeepSeek transport, driven through a real browser.
 *
 * The agent never calls chat.deepseek.com itself. It drives the site in a real
 * Chromium the way a person would: it pastes the prompt into the composer,
 * presses Enter, and reads DeepSeek's own /chat/completion response off the
 * wire. Requests therefore carry a browser's fingerprint and a human pace
 * instead of a script's.
 *
 * The sign-in comes from DEEPSEEK_SESSION_JSON - the same captured
 * authorization + cookie pair the direct-HTTP version used - seeded into the
 * browser before the page's own scripts run. With no credentials file the
 * browser profile is used instead, and you sign in once in a visible window.
 *
 * The direct-HTTP version is kept on branch `direct-api` and tag `v1.0.0`.
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
/** A short pause before each prompt: a fast person, not a machine. */
const PACE_MS = intEnv("ANYAGENT_PACE_MS", 300);

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

/* ------------------------------------------------------------------ */
/* browser discovery                                                   */
/* ------------------------------------------------------------------ */

const IS_WINDOWS = process.platform === "win32";

/** What we try to launch, in order. No `path` means Playwright's own browser. */
type Candidate = { name: string; path?: string };

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function onPath(file: string): string | undefined {
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, file);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

/** A friendly name for a browser binary, so the banner says what it is. */
function nameFor(file: string): string {
  const base = path.basename(file).toLowerCase();
  if (base.includes("msedge")) return "Microsoft Edge";
  if (base.includes("chromium")) return "Chromium";
  if (base.includes("chrome")) return "Google Chrome";
  return path.basename(file);
}

/**
 * Browsers already installed on this machine, best first.
 *
 * On Windows Edge comes first: it ships with the system, so it is the browser
 * that is expected to be there - driving a Chrome install where Chrome is not
 * the default is the more unusual of the two. ANYAGENT_BROWSER picks a
 * different one by name.
 *
 * Only Chromium-family browsers can be driven, so a system Firefox is of no
 * use here: Playwright needs its own patched build, which is what
 * `npx playwright install firefox` would download.
 */
function systemBrowsers(): Candidate[] {
  const env = process.env;
  const home = os.homedir();
  const paths: Array<string | undefined> = [];

  if (IS_WINDOWS) {
    const at = (root: string | undefined, rest: string): string | undefined =>
      root == null || root === "" ? undefined : path.join(root, rest);
    paths.push(
      // Edge before Chrome - see the note above.
      at(env["PROGRAMFILES(X86)"], "Microsoft/Edge/Application/msedge.exe"),
      at(env["PROGRAMFILES"], "Microsoft/Edge/Application/msedge.exe"),
      at(env["LOCALAPPDATA"], "Microsoft/Edge/Application/msedge.exe"),
      at(env["PROGRAMFILES"], "Google/Chrome/Application/chrome.exe"),
      at(env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"),
      at(env["LOCALAPPDATA"], "Google/Chrome/Application/chrome.exe"),
    );
  } else if (process.platform === "darwin") {
    paths.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    for (const name of [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "microsoft-edge",
      "microsoft-edge-stable",
    ]) {
      paths.push(onPath(name));
    }
    paths.push("/opt/google/chrome/chrome", "/usr/bin/chromium", "/usr/bin/google-chrome");
  }

  const found: Candidate[] = [];
  for (const file of paths) {
    if (file == null || file === "" || !isFile(file)) continue;
    if (found.some((candidate) => candidate.path === file)) continue;
    found.push({ name: nameFor(file), path: file });
  }
  return found;
}

/**
 * A browser named by ANYAGENT_BROWSER: `edge`, `chrome`, `chromium` or
 * `bundled`. Nothing here is a guess - the name has to match a real file.
 */
function matchesName(name: string, candidate: Candidate): boolean {
  if (name === "bundled") return candidate.path === undefined;
  if (candidate.path === undefined) return false;
  const file = path.basename(candidate.path).toLowerCase();
  if (name === "edge") return file.includes("msedge");
  if (name === "chrome") return file.includes("chrome") && !file.includes("chromium");
  return file.includes(name);
}

function browserWanted(): string {
  return (process.env["ANYAGENT_BROWSER"] ?? "").trim().toLowerCase();
}

/**
 * What to try, in order: the browser you configured, then the machine's own,
 * then Playwright's own downloadable Chromium as the last resort.
 */
function launchOrder(configured: string): Candidate[] {
  if (configured !== "") return [{ name: `${nameFor(configured)} (configured)`, path: configured }];
  const order = [...systemBrowsers(), { name: "Chromium (bundled)" }];
  const want = browserWanted();
  if (want === "" || want === "any") return order;
  return order.filter((candidate) => matchesName(want, candidate));
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

/**
 * The window is hidden by default, which also hides whatever the page is doing
 * - so when a turn goes wrong, say how to look at it.
 */
function windowHint(): string {
  return boolEnv("ANYAGENT_HEADLESS", true)
    ? "\n\nRun with ANYAGENT_HEADLESS=0 to watch the browser window and see what the page does."
    : "";
}

/* ------------------------------------------------------------------ */
/* credentials                                                         */
/* ------------------------------------------------------------------ */

export type Credentials = {
  token: string;
  cookie: string;
  /** Where they came from, for the banner. */
  source: string;
};

const SESSION_FILE = "DEEPSEEK_SESSION_JSON";

function bareToken(raw: unknown): string {
  let value = String(raw ?? "").trim().replace(/^bearer\s+/i, "");
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object") {
      const inner = (parsed as Record<string, unknown>)["value"];
      if (typeof inner === "string") value = inner;
    }
  } catch {
    // already a bare token
  }
  return value;
}

/** A cookie map, a JSON string of one, or the raw request header. */
function cookieHeader(raw: unknown): string {
  const fromMap = (map: object): string =>
    Object.entries(map)
      .filter(([key, value]) => key !== "" && value != null && String(value) !== "")
      .map(([key, value]) => `${key}=${String(value)}`)
      .join("; ");

  if (raw == null) return "";
  if (typeof raw === "object") return fromMap(raw);
  const value = String(raw).trim();
  if (value.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object") return fromMap(parsed as object);
    } catch {
      // a raw header value
    }
  }
  return value;
}

/**
 * The captured session, from DEEPSEEK_SESSION_JSON (inline), DEEPSEEK_SESSION_PATH
 * (a file), or ./DEEPSEEK_SESSION_JSON. Null when there is none at all.
 *
 * `token` and `cookies` are accepted as aliases, and a cookie name->value map
 * works too, so an old capture keeps working.
 */
export function loadCredentials(): Credentials | null {
  const sources: Array<{ label: string; read: () => string }> = [
    { label: "DEEPSEEK_SESSION_JSON", read: () => process.env["DEEPSEEK_SESSION_JSON"] ?? "" },
    {
      label: "DEEPSEEK_SESSION_PATH",
      read: () =>
        fs.readFileSync(path.resolve(process.cwd(), process.env["DEEPSEEK_SESSION_PATH"] ?? ""), "utf8"),
    },
    { label: SESSION_FILE, read: () => fs.readFileSync(path.resolve(process.cwd(), SESSION_FILE), "utf8") },
  ];

  for (const entry of sources) {
    let text = "";
    try {
      text = entry.read().trim();
    } catch {
      continue;
    }
    if (text === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${entry.label} is not valid JSON.`);
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`${entry.label} must be a JSON object.`);
    }

    const raw = parsed as Record<string, unknown>;
    const token = bareToken(raw["authorization"] ?? raw["token"]);
    const cookie = cookieHeader(raw["cookies"] ?? raw["cookie"]);
    if (token === "" || cookie === "") {
      throw new Error(
        `${entry.label} needs both credentials.\n\n` +
          "Copy the two request headers of any chat.deepseek.com API call\n" +
          "(DevTools -> Network -> create_pow_challenge is a good one):\n\n" +
          '  {"authorization": "Bearer <token>", "cookie": "ds_session_id=<...>; ..."}\n',
      );
    }
    const source =
      entry.label === SESSION_FILE ? path.resolve(process.cwd(), SESSION_FILE) : entry.label;
    return { token, cookie, source };
  }

  return null;
}

/**
 * The useful line out of a Chromium launch failure. Playwright's message starts
 * with the same "has been closed" line for every cause, which tells nobody
 * anything - the reason is further down, in the browser's own log.
 */
function launchReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const line =
    lines.find((line) =>
      /shared librar|cannot open|Executable doesn't exist|permission denied|no such file/i.test(line),
    ) ??
    lines[0] ??
    message;
  return line.replace(/^\[pid=\d+\]\[err]\s*/, "");
}

/** Request-header cookies, ready for the browser. */
function cookiePairs(header: string): Array<{ name: string; value: string }> {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.includes("="))
    .map((part) => {
      const eq = part.indexOf("=");
      return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1) };
    })
    .filter((cookie) => cookie.name !== "");
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
  /** Where the sign-in came from, for the banner. */
  login = "browser profile";
  /** How the browser runs, for the banner. */
  mode = "Chromium";

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

  /** Start the browser, sign in, and load the site. */
  static async open(log: (text: string) => void = () => {}): Promise<Browser> {
    const dir = profileDir();
    fs.mkdirSync(dir, { recursive: true });
    const credentials = loadCredentials();
    const headless = boolEnv("ANYAGENT_HEADLESS", true);
    const configured = (process.env["ANYAGENT_BROWSER_PATH"] ?? "").trim();

    const order = launchOrder(configured);
    if (order.length === 0) {
      // Asked for a browser that is not here: say so rather than quietly use
      // another one, which would look like the setting did nothing.
      const installed = systemBrowsers().map((candidate) => candidate.name);
      throw new Error(
        `ANYAGENT_BROWSER=${browserWanted()} but no such browser is installed.\n\n` +
          `Found: ${installed.length > 0 ? installed.join(", ") : "no Chrome, Edge or Chromium"}\n\n` +
          "Unset ANYAGENT_BROWSER to use whatever is there, or point\n" +
          "ANYAGENT_BROWSER_PATH at a browser of your choosing.",
      );
    }

    const failures: string[] = [];
    let context: BrowserContext | undefined;
    let chosen = "";

    for (const attempt of order) {
      try {
        context = await chromium.launchPersistentContext(dir, {
          headless,
          executablePath: attempt.path,
          viewport: null,
          locale: "en-US",
          // Chromium announces automated sessions by default; a person's does not.
          args: ["--disable-blink-features=AutomationControlled"],
        });
        chosen = attempt.name;
        break;
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        if (/ProcessSingleton|SingletonLock/i.test(raw)) {
          throw new Error(
            `The browser profile is already in use: ${dir}\n` +
              "Close the other AnyAgent (or the browser using that profile) and try again.",
          );
        }
        const reason = /Executable doesn't exist/i.test(raw) ? "not installed" : launchReason(error);
        failures.push(`${attempt.name}: ${reason}`);
      }
    }

    if (context === undefined) {
      throw new Error(
        "Could not start a browser.\n\n" +
          (failures.length > 0 ? `Tried:\n${failures.map((line) => `  ${line}`).join("\n")}\n\n` : "") +
          "Install one with:\n  npx playwright install chromium\n\n" +
          "AnyAgent also drives a Chrome, Edge or Chromium already on the machine,\n" +
          "and ANYAGENT_BROWSER_PATH picks a browser by hand.\n" +
          `Profile: ${dir}`,
      );
    }

    const page = context.pages()[0] ?? (await context.newPage());
    const browser = new Browser(context, page);
    browser.mode = `${chosen}, ${headless ? "hidden" : "window"}`;
    browser.login = credentials === null ? `browser profile (${dir})` : credentials.source;
    try {
      if (credentials !== null) await browser.seed(credentials);
      await browser.installModes();
      await page.goto(`${HOST}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await browser.ensureSignedIn(log, credentials);
      return browser;
    } catch (error) {
      // A failed start must not leave a browser holding the profile lock.
      await browser.close();
      throw error;
    }
  }

  /**
   * Put the captured session into the browser before the site's own scripts
   * run: the cookies as browser cookies, and the token where the site keeps
   * its own. Nothing is typed and no window is needed.
   */
  private async seed(credentials: Credentials): Promise<void> {
    const cookies = cookiePairs(credentials.cookie).map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      url: HOST,
      secure: true,
    }));
    if (cookies.length > 0) {
      try {
        await this.context.addCookies(cookies);
      } catch {
        // One odd value must not cost us the rest of the session.
        for (const cookie of cookies) await this.context.addCookies([cookie]).catch(() => {});
      }
    }

    await this.context.addInitScript((token: string) => {
      const store = (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } })
        .localStorage;
      store.setItem("userToken", JSON.stringify({ value: token, __version: "0" }));
    }, credentials.token);
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

  /**
   * The page renders a composer from cached state even when the session behind
   * it is dead, so signed in means the backend accepts the session too.
   */
  private async accountWorks(): Promise<boolean> {
    try {
      return json(await this.api("/api/v0/users/current"))["code"] === 0;
    } catch {
      return false;
    }
  }

  private async ensureSignedIn(log: (text: string) => void, credentials: Credentials | null): Promise<void> {
    if ((await this.signedIn(15_000)) && (await this.accountWorks())) return;

    if (credentials !== null) {
      throw new Error(
        `chat.deepseek.com rejected the captured session in ${credentials.source}.\n` +
          "Re-capture the authorization and cookie headers from the site.\n" +
          "The aws-waf-token cookie inside `cookie` is usually the one that expires first.",
      );
    }

    if (boolEnv("ANYAGENT_HEADLESS", true)) {
      throw new Error(
        "Not signed in, and the browser window is hidden.\n\n" +
          "Either put your DeepSeek session next to the project as DEEPSEEK_SESSION_JSON:\n" +
          '  {"authorization": "Bearer <token>", "cookie": "ds_session_id=<...>; ..."}\n\n' +
          "or run once with ANYAGENT_HEADLESS=0 to sign in in the window - the profile keeps it.",
      );
    }
    log("Not signed in. Sign in at chat.deepseek.com in the browser window - anyagent carries on by itself.");
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((await this.signedIn(2_000)) && (await this.accountWorks())) return;
      await sleep(1_000);
    }
    throw new Error(
      `Still not signed in after ${Math.round(LOGIN_TIMEOUT_MS / 1000)}s. Run anyagent again when you are ready.`,
    );
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

  /** One turn: paste the prompt, send it, and read DeepSeek's own response. */
  async ask(prompt: string): Promise<Completion> {
    // The response has to be watched for before it is sent, or it is missed.
    const pending = this.waitForCompletion(20_000);
    await this.submit(prompt);
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
          "\nSend one message by hand in the browser window to check it goes through." +
          windowHint(),
      );
    }

    const status = started.status();
    const { raw, error } = await this.readBody(started);
    const reply = raw === "" ? null : parseStream(raw);

    if (reply !== null && reply.text.trim() !== "") {
      if (reply.messageId) this.lastSeenId = Number(reply.messageId) || this.lastSeenId;
      return reply;
    }

    // DeepSeek keeps generating and stores the answer even when the stream
    // breaks, so look there before reporting an empty turn.
    const recovered = await this.recoverAnswer();
    if (recovered !== null) return recovered;

    // Nothing to recover either. A rejected session, a rate limit and a body
    // that never finished arriving all end up here, and they look identical
    // unless the response itself is allowed to say what went wrong.
    const problem = noAnswer(status, raw, error);
    if (problem !== null) throw new Error(problem + windowHint());

    return { text: "" };
  }

  /**
   * The response body, plus why there is none. A stream that never ends and a
   * connection that breaks halfway both have to be told apart from an answer
   * that really was empty.
   */
  private async readBody(response: Response): Promise<{ raw: string; error: string | null }> {
    try {
      const body = await withTimeout(response.body(), COMPLETION_TIMEOUT_MS);
      if (body === null) {
        return {
          raw: "",
          error: `nothing had arrived after ${Math.round(COMPLETION_TIMEOUT_MS / 1000)}s`,
        };
      }
      return { raw: body.toString("utf8"), error: null };
    } catch (error) {
      return { raw: "", error: error instanceof Error ? error.message : String(error) };
    }
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

  /** The prompt goes in in one go, the way a paste does - no key-by-key typing. */
  private async submit(prompt: string): Promise<void> {
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

function tryJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON
  }
  return null;
}

function json(text: string): Record<string, unknown> {
  const parsed = tryJson(text);
  if (parsed !== null) return parsed;
  throw new Error(`Unexpected response from chat.deepseek.com:\n${text.slice(0, 200)}`);
}

/** A short, single-line look at whatever came back, for an error message. */
function preview(raw: string, max = 300): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat === "") return "(the response had no body)";
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

const SESSION_HINT =
  "This is the captured DeepSeek session expiring - re-capture the authorization\n" +
  "and cookie headers from chat.deepseek.com into DEEPSEEK_SESSION_JSON.";

/**
 * Why a turn produced no answer, when what came back says why. Null when
 * nothing points at a cause, and the turn is simply empty.
 */
function noAnswer(status: number, raw: string, error: string | null): string | null {
  // DeepSeek reports its own refusals in the body, usually with HTTP 200 - a
  // bad token or a rate limit arrives as a code, not as a status.
  const envelope = tryJson(raw);
  if (envelope !== null) {
    const code = envelope["code"] ?? envelope["biz_code"];
    if (typeof code === "number" && code !== 0) {
      const msg = envelope["msg"] ?? envelope["biz_msg"] ?? envelope["message"];
      const detail = typeof msg === "string" && msg.trim() !== "" ? `: ${msg.trim()}` : "";
      return (
        `chat.deepseek.com refused this turn (code ${code}${detail}).\n\n` + SESSION_HINT
      );
    }
  }

  if (status !== 200) {
    return (
      `chat.deepseek.com answered this turn with HTTP ${status}.\n\n` +
      `${preview(raw)}\n` +
      (status === 401 || status === 403 ? `\n${SESSION_HINT}` : "")
    );
  }

  if (error !== null) {
    return (
      `No answer arrived: ${error}.\n\n` +
      "DeepSeek may still be generating it - the chat on the site has whatever it produced."
    );
  }

  return null;
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
