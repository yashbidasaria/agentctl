import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Isolated AGENTCTL_HOME for a single test. Restored on cleanup. */
export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agentctl-test-"));
  const prev = process.env.AGENTCTL_HOME;
  process.env.AGENTCTL_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.AGENTCTL_HOME;
    else process.env.AGENTCTL_HOME = prev;
    await fs.rm(home, { recursive: true, force: true });
  }
}

/** Collect every event from an async iterable. */
export async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}
