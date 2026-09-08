/**
 * Session history.
 *
 * Every conversation is stored as one JSON file under
 * ~/.anyagent/sessions/ so it can be listed and resumed later
 * (`anyagent --resume`, `anyagent --session ID`, or the startup picker).
 */

import { readdir, mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ChatMessage } from "./model.js";

export type SessionMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type SessionData = SessionMeta & {
  messages: ChatMessage[];
};

export function sessionsDir(): string {
  const override = process.env["ANYAGENT_SESSIONS_DIR"];
  if (override != null && override.trim() !== "") {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".anyagent", "sessions");
}

/** Timestamp-based id: 20260908-143502. Unique enough for a personal CLI. */
export function newSessionId(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

function sessionPath(id: string): string {
  return path.join(sessionsDir(), `${id}.json`);
}

/** Guard session ids so they can never escape the sessions directory. */
function validId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && !id.includes("..");
}

export async function listSessions(): Promise<SessionMeta[]> {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir());
  } catch {
    return []; // directory does not exist yet
  }

  const metas: SessionMeta[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await readFile(path.join(sessionsDir(), entry), "utf8");
      const data = JSON.parse(raw) as SessionData;
      if (typeof data.id !== "string" || !Array.isArray(data.messages)) continue;
      metas.push({
        id: data.id,
        title: typeof data.title === "string" ? data.title : "",
        createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
        updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
        messageCount:
          typeof data.messageCount === "number"
            ? data.messageCount
            : data.messages.length,
      });
    } catch {
      // skip corrupt/unreadable files
    }
  }

  metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return metas;
}

export async function loadSessionData(id: string): Promise<SessionData | null> {
  if (!validId(id)) return null;
  try {
    const raw = await readFile(sessionPath(id), "utf8");
    const data = JSON.parse(raw) as SessionData;
    if (!Array.isArray(data.messages)) return null;
    return data;
  } catch {
    return null;
  }
}

export async function saveSessionData(data: SessionData): Promise<void> {
  if (!validId(data.id)) {
    throw new Error(`Refusing to save session with invalid id: ${data.id}`);
  }
  await mkdir(sessionsDir(), { recursive: true });
  const payload: SessionData = {
    id: data.id,
    title: data.title ?? "",
    createdAt: data.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: data.messages.length,
    messages: data.messages,
  };
  await writeFile(sessionPath(data.id), JSON.stringify(payload, null, 2) + "\n", "utf8");
}