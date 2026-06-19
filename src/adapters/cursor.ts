import type {
  AgentAdapter,
  AgentEvent,
  DoctorReport,
  RunHandle,
  SendOptions,
  SessionHandle,
  SessionOptions,
} from "../types.js";
import { which, tryVersion } from "../util/proc.js";
import { newSessionId } from "../sessionStore.js";
import { runStreamJsonAgent } from "./streamProcess.js";

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

  send(session: SessionHandle, prompt: SendOptions): AsyncIterable<AgentEvent> {
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

    return runStreamJsonAgent({ agent: "cursor", binary: BINARY, args, session, send: prompt });
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
