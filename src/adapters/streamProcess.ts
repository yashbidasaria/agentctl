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
 * Emits the leading `meta` event, spawns the binary in its own process group,
 * parses NDJSON via the shared parser, persists pid/pgid for cross-process
 * cancel, and synthesizes a terminal `done` if the process exits without one.
 */
export async function* runStreamJsonAgent(p: StreamAgentParams): AsyncIterable<AgentEvent> {
  const runId = newRunId();
  yield {
    type: "meta",
    schemaVersion: SCHEMA_VERSION,
    agent: p.agent,
    sessionId: p.session.id,
    runId,
  };

  const proc = spawnLineStream(p.binary, p.args, {
    cwd: p.session.cwd,
    timeoutMs: p.send.timeoutSec ? p.send.timeoutSec * 1000 : undefined,
  });

  await safeUpdate(p.session.id, (r) => {
    r.status = "running";
    r.lastRunId = runId;
    r.pid = proc.pid;
    r.pgid = proc.pgid;
  });

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
    await safeUpdate(p.session.id, (r) => {
      if (parser.externalSessionId) r.externalSessionId = parser.externalSessionId;
      r.pid = undefined;
      r.pgid = undefined;
      r.status = parser.doneEmitted ? "idle" : "error";
    });
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

async function safeUpdate(
  id: string,
  mutate: Parameters<typeof updateSession>[1],
): Promise<void> {
  try {
    await updateSession(id, mutate);
  } catch {
    // session record may not exist for ad-hoc handles; ignore.
  }
}
