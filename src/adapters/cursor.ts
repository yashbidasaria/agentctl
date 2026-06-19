import type {
  AgentAdapter,
  AgentEvent,
  DoctorReport,
  RunHandle,
  SendOptions,
  SessionHandle,
  SessionOptions,
} from "../types.js";
import { SCHEMA_VERSION } from "../types.js";
import { which, tryVersion } from "../util/proc.js";
import { spawnLineStream } from "../util/subprocess.js";
import { newRunId, newSessionId, updateSession } from "../sessionStore.js";
import { StreamJsonParser } from "./streamJson.js";

const BINARY = "agent";

/**
 * Cursor adapter (subprocess path).
 *
 * Drives the Cursor CLI: `agent -p --output-format stream-json --trust ...`.
 * Output is the Claude-Code-compatible stream-json format, parsed by the shared
 * StreamJsonParser. A future enhancement may prefer `@cursor/sdk` for richer
 * lifecycle control and cloud runs; the subprocess path keeps parity today.
 *
 * Headless print mode has no interactive approval channel: `--approve all`
 * maps to `--force`, otherwise commands needing approval are denied by the CLI.
 * Hence `capabilities.approvals` is false for this path.
 */
export const cursorAdapter: AgentAdapter = {
  name: "cursor",
  capabilities: {
    resume: true,
    cloud: false,
    toolStreaming: true,
    sandbox: true,
    approvals: false,
    emits: ["meta", "assistant_text", "reasoning", "tool_call", "tool_result", "usage", "error", "done"],
  },

  async doctor(): Promise<DoctorReport> {
    const binPath = await which(BINARY);
    const version = binPath ? await tryVersion(BINARY, ["--version"]) : undefined;
    const authConfigured = Boolean(process.env.CURSOR_API_KEY) || (await hasCursorLogin());
    const notes: string[] = [];
    if (!binPath) notes.push("Install Cursor CLI: curl https://cursor.com/install -fsS | bash");
    if (!authConfigured) notes.push("Set CURSOR_API_KEY or run `agent login`.");
    return { agent: "cursor", binaryFound: Boolean(binPath), version, authConfigured, notes };
  },

  async createSession(opts: SessionOptions): Promise<SessionHandle> {
    return {
      id: newSessionId(),
      agent: "cursor",
      runtime: opts.runtime,
      cwd: opts.cwd,
    };
  },

  async resumeSession(externalId: string, opts: SessionOptions): Promise<SessionHandle> {
    return {
      id: newSessionId(),
      agent: "cursor",
      runtime: opts.runtime,
      cwd: opts.cwd,
      externalSessionId: externalId,
    };
  },

  async *send(session: SessionHandle, prompt: SendOptions): AsyncIterable<AgentEvent> {
    const runId = newRunId();
    yield { type: "meta", schemaVersion: SCHEMA_VERSION, agent: "cursor", sessionId: session.id, runId };

    if (prompt.settings !== "project") {
      process.stderr.write(
        `[agentctl] note: --settings ${prompt.settings} is not controllable via the Cursor CLI; project settings apply.\n`,
      );
    }

    const args = ["-p", "--output-format", "stream-json", "--trust", "--workspace", session.cwd];
    if (session.externalSessionId) args.push("--resume", session.externalSessionId);
    if (prompt.model) args.push("--model", prompt.model);
    if (prompt.sandbox !== undefined) args.push("--sandbox", prompt.sandbox ? "enabled" : "disabled");
    if (prompt.approve === "all") args.push("--force");
    args.push(prompt.prompt);

    const proc = spawnLineStream(BINARY, args, {
      cwd: session.cwd,
      timeoutMs: prompt.timeoutSec ? prompt.timeoutSec * 1000 : undefined,
    });

    await safeUpdate(session.id, (r) => {
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
      await safeUpdate(session.id, (r) => {
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
  },

  async respondToApproval(_run: RunHandle, _decision: "allow" | "deny"): Promise<void> {
    throw new Error(
      "cursor: interactive approval is not supported in headless mode. Use --approve all (maps to --force).",
    );
  },

  async cancel(run: RunHandle): Promise<void> {
    if (run.pgid === undefined) throw new Error("cursor: no active process group to cancel.");
    try {
      process.kill(-run.pgid, "SIGTERM");
    } catch {
      // already gone
    }
  },
};

async function hasCursorLogin(): Promise<boolean> {
  // `agent status` exits 0 when authenticated; treat absence as not-logged-in.
  const out = await tryVersion(BINARY, ["status"]);
  return out !== undefined;
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
