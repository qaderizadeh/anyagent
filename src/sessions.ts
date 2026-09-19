/**
 * Conversations on disk.
 *
 * Ollama keeps no state at all: every request carries the whole conversation.
 * So the conversation has to live somewhere, and this is that somewhere - one
 * small JSON file per conversation under ~/.anyagent/sessions.
 *
 * Nothing else is stored. Nothing is sent anywhere except to your own Ollama.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Message } from "./ollama.js";

export type { Message };

export type Session = {
  id: string;
  /** Taken from the first task, for the picker. */
  title: string;
  /** Epoch milliseconds. */
  updatedAt: number;
  messages: Message[];
};

export type SessionMeta = {
  id: string;
  title: string;
  updatedAt: number;
  count: number;
};

export function sessionsDir(): string {
  const configured = (process.env["ANYAGENT_SESSIONS_DIR"] ?? "").trim();
  return configured === "" ? path.join(os.homedir(), ".anyagent", "sessions") : path.resolve(configured);
}

function fileFor(id: string): string {
  return path.join(sessionsDir(), `${id}.json`);
}

function isMessage(value: unknown): value is Message {
  if (value === null || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    ["system", "user", "assistant"].includes(String(item["role"])) &&
    typeof item["content"] === "string"
  );
}

function parse(file: string): Session | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw === null || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    const messages = (Array.isArray(item["messages"]) ? item["messages"] : []).filter(isMessage);
    return {
      id: typeof item["id"] === "string" && item["id"] !== "" ? item["id"] : path.basename(file, ".json"),
      title: typeof item["title"] === "string" ? item["title"] : "",
      updatedAt: typeof item["updatedAt"] === "number" ? item["updatedAt"] : 0,
      messages,
    };
  } catch {
    // A half-written or hand-edited file must not stop the agent from starting.
    return null;
  }
}

/** Saved conversations, newest first. */
export function listSessions(limit = 10): SessionMeta[] {
  let names: string[];
  try {
    names = fs.readdirSync(sessionsDir());
  } catch {
    return [];
  }

  const found: SessionMeta[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const session = parse(path.join(sessionsDir(), name));
    if (session === null || session.messages.length === 0) continue;
    found.push({
      id: session.id,
      title: session.title === "" ? "(untitled)" : session.title,
      updatedAt: session.updatedAt,
      count: session.messages.length,
    });
  }
  return found.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit);
}

export function readSession(id: string): Session | null {
  return parse(fileFor(id));
}

export function newSession(): Session {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const base = `${stamp.slice(0, 8)}-${stamp.slice(8)}`;
  let id = base;
  let extra = 1;
  while (fs.existsSync(fileFor(id))) id = `${base}-${++extra}`;
  return { id, title: "", updatedAt: Date.now(), messages: [] };
}

/** Written after every task, so a crash costs at most one turn. */
export function saveSession(session: Session): void {
  if (session.messages.length === 0) return; // an empty conversation is not worth a file
  session.updatedAt = Date.now();
  fs.mkdirSync(sessionsDir(), { recursive: true });
  fs.writeFileSync(fileFor(session.id), JSON.stringify(session));
}

/** A one-line name for a task, used as the conversation's title. */
export function titleFor(task: string): string {
  const flat = task.replace(/\s+/g, " ").trim();
  if (flat === "") return "(untitled)";
  return flat.length > 60 ? `${flat.slice(0, 60)}...` : flat;
}
