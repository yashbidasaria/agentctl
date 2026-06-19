import type { AgentEvent, SendOptions, SessionHandle } from "../types.js";
import { SCHEMA_VERSION } from "../types.js";
import { spawnLineStream } from "../util/subprocess.js";
import { newRunId, updateSession } from "../sessionStore.js";
import { StreamJsonParser } from "./streamJson.js";

export interface StreamAgentParams {
  /** Adapter name, e.g. "cursor" | "claude". */
  agent: string;
  /** Binary to spawn, e.g. "agent" | "claude". */
  binary: string;
  /** Fully built argv (including the prompt) for the binary. */
  args: string[];
  session: SessionHandle;
  send: SendOptions;
}

/**
 * Shared driver for stream-json agent CLIs (Cursor, Claude Code).
 *
 * Spawns the binary, writes pid/pgid to the session record (so sessionCancel
 * can signal the process from another process), then emits the leading `meta`
 * event and parses NDJSON via the shared parser. Synthesizes a terminal `done`
 * if the process exits without one.
 */
export async function* runStreamJsonAgent(p: StreamAgentParams): AsyncIterable<AgentEvent> {
  const runId = newRunId();

  const proc = spawnLineStream(p.binary, p.args, {
    cwd: p.session.cwd,
    timeoutMs: p.send.timeoutSec != null ? p.send.timeoutSec * 1000 : undefined,
  });

  // Write pid/pgid before yielding meta so a consumer that cancels on meta
  // finds the process already registered in the session record.
  try {
    await safeUpdate(p.session.id, (r) => {
      r.status = "running";
      r.lastRunId = runId;
      r.pid = proc.pid;
      r.pgid = proc.pgid;
    });
  } catch (err) {
    proc.kill("SIGKILL");
    throw err;
  }

  yield {
    type: "meta",
    schemaVersion: SCHEMA_VERSION,
    agent: p.agent,
    sessionId: p.session.id,
    runId,
  };

  const parser = new StreamJsonParser();
  try {
    for await (const line of proc.lines) {
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      for (const event of parser.parse(obj)) yield event;
    }
  } finally {
    const timedOut = proc.state.timedOut;
    try {
      await updateSession(p.session.id, (r) => {
        if (parser.externalSessionId) r.externalSessionId = parser.externalSessionId;
        r.pid = undefined;
        r.pgid = undefined;
        r.status = parser.doneEmitted ? "idle" : timedOut ? "timeout" : "error";
      });
    } catch {
      // Swallow cleanup errors to avoid masking the run's original error or result.
    }
  }

  if (!parser.doneEmitted) {
    const outcome = proc.state.timedOut ? "timeout" : "error";
    yield {
      type: "done",
      outcome,
      exitCode: outcome === "timeout" ? 4 : 2,
      result: proc.state.timedOut ? "timed out" : "agent exited without a result",
    };
  }
}

// Swallows only "Session not found" (ad-hoc handles with no persisted record).
// Real I/O errors (ENOSPC, lock timeout, etc.) are re-thrown.
async function safeUpdate(
  id: string,
  mutate: Parameters<typeof updateSession>[1],
): Promise<void> {
  try {
    await updateSession(id, mutate);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Session not found")) return;
    throw err;
  }
}
