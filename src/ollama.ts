/**
 * The Ollama transport.
 *
 * Ollama runs on this machine and keeps no conversation of its own, so there is
 * very little to do here: list the models that are installed, and ask one of
 * them for a reply.
 *
 * The reply shape is enforced by Ollama itself. The request carries a JSON
 * schema, so the model cannot answer with prose or a code fence no matter how
 * small it is - which is why there are no parsing heuristics in this file.
 */

const DEFAULT_URL = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_MS = 300_000;

/** The one answer shape. Ollama turns this into a grammar the model must follow. */
const REPLY_SCHEMA = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description:
        "A short note for the user about the step you are taking, or your final answer when there is no command.",
    },
    command: {
      type: "string",
      description:
        "The one shell command to run next. Running commands is how you inspect or change the user's machine, so use this whenever the task needs a fact about that machine. Empty only when the task is finished or you are truly blocked.",
    },
  },
  required: ["text", "command"],
};

export type Message = { role: "system" | "user" | "assistant"; content: string };

/** A failure worth reading: it is printed to the user as it is. */
class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function baseUrl(): string {
  const configured = (process.env["OLLAMA_URL"] ?? "").trim();
  return (configured === "" ? DEFAULT_URL : configured).replace(/\/+$/, "");
}

/**
 * Whether to send Ollama's `think` flag.
 *
 * Undefined means "leave it alone": thinking models think by default, and
 * non-thinking ones reject the flag outright, so the model's own default is the
 * right answer unless the user asks for something else.
 */
export function thinking(): boolean | undefined {
  const raw = (process.env["ANYAGENT_THINKING"] ?? "").trim().toLowerCase();
  if (raw === "") return undefined;
  return ["1", "true", "yes", "on"].includes(raw);
}

export function thinkingLabel(): string {
  const value = thinking();
  return value === undefined ? "model default" : value ? "on" : "off";
}

function timeoutMs(): number {
  const value = Number(process.env["OLLAMA_TIMEOUT_MS"]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
}

/** Make the connection failure the user's problem in a way they can fix. */
function cannotConnect(url: string, error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const why = cause?.code ?? cause?.message ?? message(error);
  return (
    `Cannot connect to Ollama at ${url}\n\n` +
    "Start it first:\n  ollama serve\n\n" +
    "and check that a model is installed:\n  ollama list\n  ollama pull llama3.2\n\n" +
    `Set OLLAMA_URL if it listens somewhere else. (${why})`
  );
}

export class Ollama {
  constructor(
    readonly model: string,
    readonly url = baseUrl(),
  ) {}

  /** The models installed on this machine. Also the health check. */
  static async models(url = baseUrl()): Promise<string[]> {
    return new Ollama("", url).list();
  }

  async list(): Promise<string[]> {
    const body = await this.send("/api/tags", null);
    const list = Array.isArray(body["models"]) ? body["models"] : [];
    return list
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
      .map((item) => String(item["name"] ?? item["model"] ?? ""))
      .filter((name) => name !== "");
  }

  /**
   * One completion, as the model's raw text. The caller parses the JSON - or
   * rather, finds that it is already valid JSON, because of the schema above.
   */
  async chat(messages: Message[]): Promise<string> {
    const base: Record<string, unknown> = { model: this.model, messages, stream: false };
    const think = thinking();
    if (think !== undefined) base["think"] = think;

    // Older Ollama builds only take the plain "json" mode, so fall back to it
    // when our request, not the model, is what got rejected.
    const formats: unknown[] = [REPLY_SCHEMA, "json"];
    for (let attempt = 0; attempt < formats.length; attempt++) {
      try {
        const body = await this.send("/api/chat", { ...base, format: formats[attempt] });
        const reply = body["message"];
        if (reply === null || typeof reply !== "object") {
          throw new Error(`Ollama sent a reply with no message in it:\n${JSON.stringify(body).slice(0, 300)}`);
        }
        const content = (reply as Record<string, unknown>)["content"];
        return typeof content === "string" ? content : "";
      } catch (error) {
        if (attempt + 1 < formats.length && error instanceof HttpError && error.status === 400) continue;
        throw error;
      }
    }
    return "";
  }

  private async send(pathname: string, body: unknown): Promise<Record<string, unknown>> {
    const url = `${this.url}${pathname}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: body === null ? "GET" : "POST",
        headers: body === null ? undefined : { "content-type": "application/json" },
        body: body === null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs()),
      });
    } catch (error) {
      throw new Error(cannotConnect(this.url, error));
    }

    const text = await response.text().catch(() => "");
    if (!response.ok) throw new HttpError(this.explain(response.status, text), response.status);

    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // fall through
    }
    throw new Error(`Ollama sent something that is not JSON for ${pathname}:\n${text.slice(0, 300)}`);
  }

  /** Turn an HTTP failure into something the user can act on. */
  private explain(status: number, body: string): string {
    const detail = (body.match(/"error"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? body).replace(/\\"/g, '"');
    if (/not found|no such model|try pulling/i.test(detail)) {
      return (
        `Ollama does not have the model "${this.model}".\n\n` +
        `Pull it first:\n  ollama pull ${this.model}\n\n` +
        `Installed models:\n  ollama list`
      );
    }
    if (/thinking/i.test(detail)) {
      return (
        `The model "${this.model}" refused the thinking setting: ${detail}\n\n` +
        "Unset ANYAGENT_THINKING to use the model's own default, or point it at a\n" +
        "model that supports it (Ollama's `think` flag only works on thinking models)."
      );
    }
    return `Ollama returned HTTP ${status}:\n${detail.slice(0, 400)}`;
  }
}
