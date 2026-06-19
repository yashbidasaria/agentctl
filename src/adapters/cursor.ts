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

const BINARY = "agent";

/**
 * Cursor adapter.
 *
 * Planned: prefer `@cursor/sdk` for local runs (same harness as the `agent`
 * CLI), with a subprocess fallback to `agent -p ... --output-format stream-json`.
 * Implemented incrementally in Phase 1 — see plan.
 */
export const cursorAdapter: AgentAdapter = {
  name: "cursor",
  capabilities: {
    resume: true,
    cloud: true,
    toolStreaming: true,
    sandbox: true,
    approvals: true,
    emits: ["meta", "assistant_text", "tool_call", "tool_result", "status", "error", "done"],
  },

  async doctor(): Promise<DoctorReport> {
    const binPath = await which(BINARY);
    const version = binPath ? await tryVersion(BINARY) : undefined;
    const authConfigured = Boolean(process.env.CURSOR_API_KEY);
    const notes: string[] = [];
    if (!binPath) notes.push("Install Cursor CLI: curl https://cursor.com/install -fsS | bash");
    if (!authConfigured) notes.push("Set CURSOR_API_KEY or run `agent login`.");
    return { agent: "cursor", binaryFound: Boolean(binPath), version, authConfigured, notes };
  },

  async createSession(_opts: SessionOptions): Promise<SessionHandle> {
    throw new Error("cursor adapter: createSession not implemented yet (Phase 1).");
  },

  async resumeSession(_externalId: string, _opts: SessionOptions): Promise<SessionHandle> {
    throw new Error("cursor adapter: resumeSession not implemented yet (Phase 1).");
  },

  // eslint-disable-next-line require-yield
  async *send(_session: SessionHandle, _prompt: SendOptions): AsyncIterable<AgentEvent> {
    throw new Error("cursor adapter: send not implemented yet (Phase 1).");
  },

  async respondToApproval(_run: RunHandle, _decision: "allow" | "deny"): Promise<void> {
    throw new Error("cursor adapter: respondToApproval not implemented yet (Phase 1).");
  },

  async cancel(_run: RunHandle): Promise<void> {
    throw new Error("cursor adapter: cancel not implemented yet (Phase 1).");
  },
};
