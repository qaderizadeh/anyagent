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
/** Chat ids in the address bar. Newer builds drop the /a, older ones have it. */
const CHAT_URL = /\/chat\/s\/([0-9a-z-]{8,})/i;

const LOGIN_TIMEOUT_MS = intEnv("ANYAGENT_LOGIN_TIMEOUT_MS", 300_000);
const COMPLETION_TIMEOUT_MS = intEnv("ANYAGENT_COMPLETION_TIMEOUT_MS", 300_000);
/** How long to wait for the answer to appear on the page. */
const ANSWER_WAIT_MS = intEnv("ANYAGENT_ANSWER_TIMEOUT_MS", 180_000);
/** How often the page is looked at, and how still it has to be to be finished. */
const POLL_MS = 500;
const STABLE_POLLS = 4;
/** Look at what the chat stored every N polls, rather than every poll. */
const HISTORY_EVERY = 4;
/** How long the page gets to catch up once the response has ended and said nothing. */
const STALL_GRACE_MS = intEnv("ANYAGENT_STALL_GRACE_MS", 8_000);
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

/** One reading of a turn, filled in as the pieces arrive. */
type Turn = {
  answer: Completion | null;
  problem: string | null;
  status: number | null;
  raw: string;
  /** Whether DeepSeek's completion request was seen at all. */
  sawResponse: boolean;
  /** Whether the response has been read right through. */
  done: boolean;
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

  /**
   * One turn: paste the prompt, send it, and read the answer.
   *
   * Three independent readings of the same turn, because any one of them can
   * let us down on its own: what the page shows, what the chat stored, and the
   * response body. The response has the useful property of being finished or
   * not, so it is what says the turn is over; the other two are what say what
   * was said. A chunk shape we do not recognise used to parse to an empty turn,
   * and an empty turn is indistinguishable from a site that said nothing.
   */
  async ask(prompt: string): Promise<Completion> {
    const before = await this.renderedAnswer();
    const beforeId = this.lastSeenId;
    // Watched for from before the prompt is sent, or the response is missed.
    const response = this.waitForCompletion(COMPLETION_TIMEOUT_MS);
    const turn: Turn = { answer: null, problem: null, status: null, raw: "", sawResponse: false, done: false };
    void response.then(
      async (started) => {
        turn.sawResponse = started !== null;
        try {
          const result = await this.readTurn(started);
          turn.answer = result.answer;
          turn.problem = result.problem;
          turn.status = result.status;
          turn.raw = result.raw;
        } catch (error) {
          turn.problem = error instanceof Error ? error.message : String(error);
        } finally {
          turn.done = true;
        }
      },
      (error: unknown) => {
        turn.problem = error instanceof Error ? error.message : String(error);
        turn.done = true;
      },
    );

    await this.submit(prompt);

    const deadline = Date.now() + ANSWER_WAIT_MS;
    let rendered = "";
    let still = 0;
    let poll = 0;
    let stalledAt = 0;
    while (Date.now() < deadline) {
      // The response is in and readable: that is this turn.
      //
      // The stream is the one reading that knows which channel every byte
      // arrived on - the answer from the reasoning - so when it has something to
      // say it is what is used. The chat's own copy is the fallback, not the
      // first choice, because it is one string with the two run together.
      if (turn.answer !== null) return turn.answer;

      const now = await this.renderedAnswer();
      // Something new is on the page. It is finished when it stops changing.
      if (now !== "" && now !== before) {
        still = now === rendered ? still + 1 : 0;
        rendered = now;
        if (still >= STABLE_POLLS) {
          // What the chat stored is the whole answer, not whatever had
          // rendered by then, so prefer it when it is there.
          const stored = await this.storedAnswer(beforeId);
          return stored ?? { text: rendered };
        }
      }

      poll += 1;
      // What the chat stored - but only once the response is over and carried
      // nothing, so it can never displace what the stream said.
      if (poll % HISTORY_EVERY === 0 && turn.done && turn.answer === null) {
        const stored = await this.storedAnswer(beforeId);
        if (stored !== null) return stored;
      }

      // Nothing has gone out: in case Enter did not submit, press the button.
      if (!turn.sawResponse && poll === 12) await this.clickSend();

      // The response is in and carried nothing, and the page has shown nothing.
      // Give the page a moment to catch up, then stop waiting for it.
      if (turn.done && rendered === "") {
        if (stalledAt === 0) stalledAt = Date.now();
        else if (Date.now() - stalledAt > STALL_GRACE_MS) break;
      } else {
        stalledAt = 0;
      }

      await sleep(POLL_MS);
    }

    if (turn.answer !== null) return turn.answer;
    // The response may still be arriving. Give it the rest of its own time.
    await response.then(() => undefined, () => undefined);
    if (turn.answer !== null) return turn.answer;

    if (!turn.sawResponse) {
      const seen = [...new Set(this.posted)];
      throw new Error(
        `DeepSeek never sent ${COMPLETION_PATH}, so this turn did not go out.\n` +
          (seen.length > 0 ? `Requests seen: ${seen.join(", ")}` : "No request was seen at all.") +
          "\nSend one message by hand in the browser window to check it goes through." +
          windowHint(),
      );
    }

    // A rejected session, a rate limit and an empty answer all end up here, and
    // they look identical unless the response is allowed to say what happened.
    if (turn.problem !== null) throw new Error(turn.problem + windowHint());

    // Nothing on the page, nothing stored and nothing readable in the response.
    // Keep the response itself, so its shape can be seen rather than guessed at.
    throw new Error(
      `Nothing came back from DeepSeek for this turn (HTTP ${turn.status}, ${turn.raw.length} bytes).\n` +
        "The page showed no answer and the chat stored none, so the response was kept here:\n" +
        `  ${this.saveDump(turn.raw, turn.status ?? 0)}\n` +
        "Send that file to get the reader fixed." +
        windowHint(),
    );
  }

  /**
   * What the response says this turn was. Never throws: a response we cannot
   * read is a reason to read the page instead, not to end the turn.
   */
  private async readTurn(started: Response | null): Promise<{
    answer: Completion | null;
    problem: string | null;
    status: number | null;
    raw: string;
  }> {
    if (started === null) return { answer: null, problem: null, status: null, raw: "" };

    const status = started.status();
    const { raw, error } = await this.readBody(started);

    let reply: Completion | null = null;
    let refusal: string | null = null;
    try {
      reply = raw === "" ? null : parseStream(raw);
    } catch (thrown) {
      // A refusal inside the stream: DeepSeek said why, so keep that.
      refusal = thrown instanceof Error ? thrown.message : String(thrown);
    }
    this.dumpTurn(status, raw, reply?.text ?? null);

    if (refusal !== null) return { answer: null, problem: refusal, status, raw };
    if (reply !== null && reply.text.trim() !== "") {
      if (reply.messageId) this.lastSeenId = Number(reply.messageId) || this.lastSeenId;
      return { answer: reply, problem: null, status, raw };
    }
    return { answer: null, problem: noAnswer(status, raw, error), status, raw };
  }

  /**
   * Keep the bytes of this turn when ANYAGENT_DEBUG is on.
   *
   * Every fault this transport has had was a misreading of the stream, and a
   * stream cannot be argued with - only looked at. One file, overwritten each
   * turn, so what is in it is always the turn that just happened.
   */
  private dumpTurn(status: number, raw: string, reply: string | null): void {
    if (!boolEnv("ANYAGENT_DEBUG", false)) return;
    const file = path.join(profileDir(), "last-turn.txt");
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        [
          `when: ${new Date().toISOString()}`,
          `url: ${this.page.url()}`,
          `status: ${status}`,
          `read back: ${reply === null ? "(nothing)" : JSON.stringify(reply.slice(0, 2000))}`,
          "",
          "--- response body ---",
          raw,
        ].join("\n"),
      );
      process.stdout.write(`  (debug: this turn's response is in ${file})\n`);
    } catch {
      // a dump that cannot be written must not cost us the turn
    }
  }

  /**
   * The answer as the page shows it, with its code fences put back.
   *
   * This is the one source that cannot drift out of step with the site: the
   * model's words are on the screen because the site put them there. Reasoning
   * is shown in a block of its own, and that block is skipped by name - it is
   * not the answer, and picking a command out of it would run something the
   * model only thought about.
   */
  private async renderedAnswer(): Promise<string> {
    const text = await this.page
      .evaluate((notTheAnswer: string) => {
        // The list comes from this side, so the two readers cannot disagree.
        const reasoning = new RegExp(notTheAnswer, "i");
        type Node = {
          nodeType: number;
          nodeValue?: string | null;
          textContent?: string | null;
          tagName?: string;
          className?: unknown;
          getAttribute?: (name: string) => string | null;
          querySelector?: (selector: string) => Node | null;
          querySelectorAll?: (selector: string) => { length: number; [index: number]: Node };
          childNodes?: { length: number; [index: number]: Node };
        };

        const doc = (
          globalThis as unknown as {
            document: { querySelectorAll(selector: string): { length: number; [index: number]: Node } };
          }
        ).document;

        const classOf = (node: Node): string =>
          typeof node.className === "string" ? node.className : "";

        const render = (node: Node): string => {
          let out = "";
          const children = node.childNodes;
          if (children === undefined) return out;
          for (let index = 0; index < children.length; index++) {
            const child = children[index];
            if (child === undefined) continue;
            if (child.nodeType === 3) {
              out += child.nodeValue ?? "";
              continue;
            }
            if (child.nodeType !== 1) continue;
            const classes = classOf(child);
            if (reasoning.test(classes)) continue;
            const tag = (child.tagName ?? "").toLowerCase();
            if (tag === "br") {
              out += "\n";
              continue;
            }
            if (tag === "pre") {
              const code = child.querySelector?.("code") ?? child;
              const language =
                /language-([\w+#.-]+)/.exec(classOf(code))?.[1] ??
                child.getAttribute?.("data-language") ??
                "";
              const body = (code.textContent ?? "").replace(/\n+$/, "");
              out += `\n\`\`\`${language}\n${body}\n\`\`\`\n`;
              continue;
            }
            if (tag === "code") {
              out += `\`${child.textContent ?? ""}\``;
              continue;
            }
            const inner = render(child);
            out += /^(p|div|li|ul|ol|h[1-6]|blockquote|table|tr|pre|section|article)$/.test(tag)
              ? `\n${inner}\n`
              : inner;
          }
          return out;
        };

        // Most specific first, so a build that names it differently still works.
        for (const selector of [".ds-markdown", '[class*="ds-markdown"]', '[class*="markdown"]']) {
          let found;
          try {
            found = doc.querySelectorAll(selector);
          } catch {
            continue;
          }
          if (found.length === 0) continue;
          const last = found[found.length - 1];
          if (last === undefined || reasoning.test(classOf(last))) continue;
          const text = render(last).replace(/\n{3,}/g, "\n\n").trim();
          if (text !== "") return text;
        }
        return "";
      }, NOT_THE_ANSWER.source)
      .catch(() => "");
    return text.replace(/\n{3,}/g, "\n\n").trim();
  }

  /**
   * The newest answer the chat has stored, when it is newer than the last one
   * we saw. Reading it also moves `lastSeenId` on, so the same answer is never
   * mistaken for the next turn's.
   */
  private async storedAnswer(afterId: number): Promise<Completion | null> {
    const answers = (await this.history().catch(() => [])).filter(
      (message) => message.role === "assistant" && message.content.trim() !== "",
    );
    const last = answers.length > 0 ? answers[answers.length - 1]! : null;
    if (last === null) return null;
    this.lastSeenId = Math.max(this.lastSeenId, last.id);
    return last.id > afterId ? { text: last.content, messageId: String(last.id) } : null;
  }

  /** Keep the response of a turn that could not be read, so it can be looked at. */
  private saveDump(raw: string, status: number): string {
    const file = path.join(profileDir(), "last-turn.txt");
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        `when: ${new Date().toISOString()}\nurl: ${this.page.url()}\nstatus: ${status}\n\n${raw}\n`,
      );
      return file;
    } catch {
      return "(the response could not be saved)";
    }
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
    const list = Array.isArray(data["chat_messages"])
      ? data["chat_messages"]
      : Array.isArray(data["messages"])
        ? data["messages"]
        : [];
    return list
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
      .map((item) => ({
        id: Number(item["message_id"] ?? item["id"] ?? 0),
        // The role has been written both ways, and comparing case-sensitively
        // quietly finds no answers at all when it is the other one.
        role: String(item["role"] ?? "").toLowerCase(),
        content: messageText(item["content"]),
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
 * The names the site gives to the parts of a turn that are not its answer.
 *
 * This one is for class names on the page - the block the thinking is rendered
 * in - and is the only place a loose match is safe: a name we do not recognise
 * there loses the answer, so it is used to *skip* what is clearly not the
 * answer rather than to decide what is.
 */
const NOT_THE_ANSWER = /think|reason|cot|analysis|chain|search|tip/i;

/**
 * The two channels a turn arrives on. There is no third: everything the site
 * sends is either what the model is saying or what it is thinking.
 */
type Channel = "answer" | "reasoning";

/**
 * The channel a fragment's type names, or null when it names nothing we know.
 *
 * The site's types are `THINK` and `RESPONSE` (and `SEARCH`), and this is a
 * whitelist on purpose. Guessing that an unfamiliar name is the answer is how
 * the reasoning gets read as the reply - and how a fenced command inside it gets
 * run. An unfamiliar name therefore carries no text at all: the answer is lost,
 * which is visible and fixable, rather than the thinking being shown, which is
 * neither.
 */
function typeChannel(type: string): Channel | null {
  const name = type.trim().toUpperCase();
  if (name === "") return null;
  if (name === "RESPONSE" || name === "TEXT" || name === "ANSWER") return "answer";
  if (name.startsWith("THINK") || name.startsWith("REASON") || name.startsWith("COT")) return "reasoning";
  if (name.startsWith("SEARCH")) return "reasoning";
  return null;
}

/**
 * The channel a stream field names, or null when it names neither.
 *
 * Matched on the last path segment, not on the whole path, because every field
 * begins with "response" - a loose match would read `response/status` as the
 * answer and append the word FINISHED to it.
 */
function fieldChannel(field: string): Channel | null {
  const leaf = (field.toLowerCase().split("/").pop() ?? "").trim();
  if (leaf === "content" || leaf === "text" || leaf === "answer") return "answer";
  if (leaf.startsWith("think") || leaf.startsWith("reason") || leaf.startsWith("cot")) return "reasoning";
  return null;
}

/** A {"type": "THINK", "content": "..."} entry, which is what a message is made of. */
type Fragment = { type: string; content: string };

function fragmentOf(item: unknown): Fragment | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
  const object = item as Record<string, unknown>;
  if (typeof object["content"] !== "string") return null;
  return {
    type: typeof object["type"] === "string" ? object["type"] : "",
    content: object["content"],
  };
}

/**
 * The answer inside a list of fragments - or null when the list holds no
 * fragments at all. Empty is a real answer here: a list of nothing but reasoning
 * has an answer of nothing, not "show the raw JSON".
 */
function fragmentText(items: unknown[]): string | null {
  const fragments = items.map(fragmentOf).filter((item): item is Fragment => item !== null);
  if (fragments.length === 0) return null;
  return fragments
    .filter((fragment) => typeChannel(fragment.type) === "answer")
    .map((fragment) => fragment.content)
    .join("");
}

/**
 * The text a JSON value carries, whatever shape it arrived in: a string, a list
 * of fragments, a full response snapshot, or an object holding it under one of
 * its usual names. The value has taken all of these shapes over the life of the
 * site, and a shape we do not read is text silently lost.
 *
 * One thing is never text: a fragment the site marks as reasoning. A message is
 * a list of typed fragments, the model's thinking is one of them, and joining
 * them all is how its private thoughts end up looking like its answer.
 */
function messageText(value: unknown): string {
  if (typeof value === "string") {
    // Some payloads carry the fragment list as a JSON string.
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          const text = fragmentText(parsed);
          if (text !== null) return text;
        }
      } catch {
        // ordinary text that merely starts with a bracket
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    const text = fragmentText(value);
    if (text !== null) return text;
    return value.map(messageText).join("");
  }
  if (value === null || typeof value !== "object") return "";

  const fragment = fragmentOf(value);
  if (fragment !== null && typeChannel(fragment.type) !== "answer") return "";

  const object = value as Record<string, unknown>;
  for (const key of ["content", "text", "value", "answer"]) {
    if (typeof object[key] === "string") return object[key] as string;
  }
  for (const key of ["fragments", "contents", "items", "data"]) {
    const inner = object[key];
    if (inner !== undefined) {
      const text = messageText(inner);
      if (text !== "") return text;
    }
  }
  return "";
}

/**
 * Read the streamed reply.
 *
 * The payload is a pointer stream:
 *   {"p":"response/fragments","v":[{"type":"RESPONSE","content":"Hello"}]}
 *   {"v":{"response":{"fragments":[...]}}}       the whole response so far
 *   {"p":"response/fragments/-1/content","v":" more"}  append to the last one
 *   {"v":" more"}                                the same, with no field at all
 *   {"p":"response/status","v":"FINISHED"}        the turn is over
 * `event: ready` carries the assistant message id.
 *
 * The reasoning travels in this very stream, under the very same field. What
 * tells them apart is the fragment type, named once - `THINK` for the thinking,
 * `RESPONSE` for the reply - and then a run of appends that name nothing at all.
 * So the channel is *carried*, never re-derived per chunk: a chunk's field
 * cannot say which of the two it belongs to, because both use the same one.
 *
 * Reading it any other way joins the model's thinking to its answer, shows the
 * user its private thoughts, and runs a fenced command found inside them as
 * though the model had asked for it.
 */
export function parseStream(raw: string): Completion {
  let text = "";
  let messageId = "";
  let event = "";
  /**
   * Which fragment is being streamed.
   *
   * It starts as the reasoning, not the answer. The site sends the thinking
   * first, and anything that arrives before a fragment has said it is the
   * answer is the thinking - so the reply is built from what has *declared*
   * itself, never from what has not.
   */
  let channel: Channel = "reasoning";

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

    if (event === "ready") {
      const id = item["response_message_id"] ?? item["request_message_id"];
      if (id != null) messageId = String(id);
    }
    event = "";

    const path = typeof item["p"] === "string" ? item["p"] : "";
    const op = typeof item["o"] === "string" ? item["o"] : "";
    const value = item["v"];

    /** Read a list of fragments: each one's type sets the channel. */
    const readFragments = (list: unknown): boolean => {
      if (!Array.isArray(list)) return false;
      let seen = false;
      for (const entry of list) {
        const fragment = fragmentOf(entry);
        // An entry whose type we do not know carries no text *and* leaves the
        // channel alone - it is not the answer and not a reason to change what
        // is being streamed.
        if (fragment === null) continue;
        const named = typeChannel(fragment.type);
        if (named === null) continue;
        seen = true;
        channel = named;
        if (named === "answer") text += fragment.content;
      }
      return seen;
    };

    // A whole-response snapshot, wrapped around the fragments it is built from.
    const snapshot =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)["response"]
        : null;
    if (snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot)) {
      const whole = snapshot as Record<string, unknown>;
      readFragments(whole["fragments"]);
      if (whole["message_id"] != null) messageId = String(whole["message_id"]);
      continue;
    }

    // A fragment list: the only thing that can set the channel.
    if (Array.isArray(value)) {
      if (readFragments(value)) continue;
    }

    // A message id is not text, whatever field it arrives under.
    if (/message_id/i.test(path) && (typeof value === "number" || typeof value === "string")) {
      messageId = String(value);
      continue;
    }

    // An append with no type of its own: it belongs to the fragment being
    // streamed, whichever that is. `response/fragments/-1/content` means "the
    // content of the last fragment", whatever id that fragment happens to be.
    const appends =
      /^response\/fragments\/[^/]*\/content$/.test(path) ||
      (path === "" && op === "APPEND" && value !== undefined) ||
      (path === "" && op === "" && typeof value === "string");
    if (appends) {
      const piece = typeof value === "string" ? value : "";
      if (channel === "answer") text += piece;
      continue;
    }

    // A field that names a channel outright - `response/content` is the answer,
    // `response/thinking_content` is not. Anything else says nothing and is left
    // alone rather than guessed at.
    const named = path === "" ? null : fieldChannel(path);
    if (named === null) continue;
    channel = named;
    const piece = typeof value === "string" ? value : messageText(value);
    if (named === "answer") text += piece;
  }

  return { text, messageId: messageId || undefined };
}
