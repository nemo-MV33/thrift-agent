// A run's state on disk, so a run that stopped on an outage or a spent budget
// can pick up where it left off with --resume instead of starting over.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Message } from "./context.js";

export type Session = {
  version: 1;
  task: string;
  workspace: string;
  mode: "thrift" | "naive" | "private";
  model: string;
  fallbacks: string[];
  pinned: boolean;
  messages: Message[];
  steps: number;
  tokens: number;
  wrote: boolean;
  savedAt: string;
  reason: string;
};

export async function saveSession(file: string, session: Session): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Write then rename, so a crash mid-write never leaves half a session behind.
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(session, null, 2));
  await fs.rename(tmp, file);
}

export async function loadSession(file: string): Promise<Session | null> {
  try {
    const s = JSON.parse(await fs.readFile(file, "utf8"));
    if (s?.version !== 1 || !Array.isArray(s.messages) || typeof s.task !== "string") return null;
    return s as Session;
  } catch {
    return null;
  }
}

export async function clearSession(file: string): Promise<void> {
  await fs.rm(file, { force: true });
}
