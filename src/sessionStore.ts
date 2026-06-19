import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { sessionsDir, sessionPath } from "./paths.js";
import type { Runtime } from "./types.js";

export interface SessionRecord {
  id: string;
  agent: string;
  runtime: Runtime;
  cwd: string;
  externalSessionId?: string;
  createdAt: string;
  updatedAt: string;
  lastRunId?: string;
  status: "idle" | "running" | "waiting_approval" | "error";
  /** Guards against concurrent `send` to the same session. */
  busy: boolean;
  /** OS pid/pgid of the active local run (enables cross-process cancel). */
  pid?: number;
  pgid?: number;
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(sessionsDir(), { recursive: true });
}

export function newSessionId(): string {
  return `sess_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function newRunId(): string {
  return `run_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export async function createSession(
  rec: Omit<SessionRecord, "createdAt" | "updatedAt" | "status" | "busy">,
): Promise<SessionRecord> {
  await ensureDir();
  const now = new Date().toISOString();
  const full: SessionRecord = { ...rec, createdAt: now, updatedAt: now, status: "idle", busy: false };
  await atomicWrite(full);
  return full;
}

export async function readSession(id: string): Promise<SessionRecord | undefined> {
  try {
    const raw = await fs.readFile(sessionPath(id), "utf8");
    return JSON.parse(raw) as SessionRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function listSessions(): Promise<SessionRecord[]> {
  await ensureDir();
  const files = await fs.readdir(sessionsDir());
  const records: SessionRecord[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const rec = await readSession(file.replace(/\.json$/, ""));
    if (rec) records.push(rec);
  }
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function atomicWrite(rec: SessionRecord): Promise<void> {
  const target = sessionPath(rec.id);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(rec, null, 2), "utf8");
  await fs.rename(tmp, target);
}

/**
 * Lock-guarded read-modify-write. Creates the file first if needed so the
 * lockfile has something to anchor to.
 */
export async function updateSession(
  id: string,
  mutate: (rec: SessionRecord) => void,
): Promise<SessionRecord> {
  await ensureDir();
  const target = sessionPath(id);
  const release = await lockfile.lock(target, {
    retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 500 },
    realpath: false,
  });
  try {
    const current = await readSession(id);
    if (!current) throw new Error(`Session not found: ${id}`);
    mutate(current);
    current.updatedAt = new Date().toISOString();
    await atomicWrite(current);
    return current;
  } finally {
    await release();
  }
}
