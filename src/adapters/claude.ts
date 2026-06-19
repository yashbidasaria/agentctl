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

const BINARY = "claude";

/**
 * Claude Code adapter.
 *
 * Planned: always subprocess — spawn `claude -p ... --output-format stream-json`
 * in its own process group, parse NDJSON to normalized AgentEvents, support
 * `--resume`. Implemented incrementally in Phase 2 — see plan.
 */
export const claudeAdapter: AgentAdapter = {
  name: "claude",
  capabilities: {
    resume: true,
    cloud: false,
    toolStreaming: true,
    sandbox: false,
    approvals: true,
    emits: ["meta", "assistant_text", "tool_call", "tool_result", "usage", "status", "error", "done"],
  },

  async doctor(): Promise<DoctorReport> {
    const binPath = await which(BINARY);
    const version = binPath ? await tryVersion(BINARY) : undefined;
    const authConfigured = Boolean(process.env.ANTHROPIC_API_KEY);
    const notes: string[] = [];
    if (!binPath) notes.push("Install Claude Code: https://github.com/anthropics/claude-code");
    if (!authConfigured) notes.push("Set ANTHROPIC_API_KEY or run the Claude Code login flow.");
    return { agent: "claude", binaryFound: Boolean(binPath), version, authConfigured, notes };
  },

  async createSession(_opts: SessionOptions): Promise<SessionHandle> {
    throw new Error("claude adapter: createSession not implemented yet (Phase 2).");
  },

  async resumeSession(_externalId: string, _opts: SessionOptions): Promise<SessionHandle> {
    throw new Error("claude adapter: resumeSession not implemented yet (Phase 2).");
  },

  // eslint-disable-next-line require-yield
  async *send(_session: SessionHandle, _prompt: SendOptions): AsyncIterable<AgentEvent> {
    throw new Error("claude adapter: send not implemented yet (Phase 2).");
  },

  async respondToApproval(_run: RunHandle, _decision: "allow" | "deny"): Promise<void> {
    throw new Error("claude adapter: respondToApproval not implemented yet (Phase 2).");
  },

  async cancel(_run: RunHandle): Promise<void> {
    throw new Error("claude adapter: cancel not implemented yet (Phase 2).");
  },
};
