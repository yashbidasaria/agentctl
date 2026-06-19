import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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

const BINARY = "claude";

/**
 * Claude Code adapter (subprocess path).
 *
 * Drives the Claude Code CLI: `claude -p --output-format stream-json --verbose`.
 * Output is the same stream-json format as Cursor, so it reuses the shared
 * parser and process driver. Resume uses `--resume <session_id>`.
 *
 * Headless print mode has no interactive approval channel: `--approve all`
 * maps to `--permission-mode bypassPermissions`; otherwise tools requiring
 * approval are denied. Hence `capabilities.approvals` is false here.
 */
export const claudeAdapter: AgentAdapter = {
  name: "claude",
  capabilities: {
    resume: true,
    cloud: false,
    toolStreaming: true,
    sandbox: false,
    approvals: false,
    emits: ["meta", "assistant_text", "reasoning", "tool_call", "tool_result", "usage", "error", "done"],
  },

  async doctor(): Promise<DoctorReport> {
    const binPath = await which(BINARY);
    const version = binPath ? await tryVersion(BINARY, ["--version"]) : undefined;
    const authConfigured = Boolean(process.env.ANTHROPIC_API_KEY) || (await hasClaudeLogin());
    const notes: string[] = [];
    if (!binPath) notes.push("Install Claude Code: https://github.com/anthropics/claude-code");
    if (!authConfigured) notes.push("Set ANTHROPIC_API_KEY or run `claude` once to log in.");
    return { agent: "claude", binaryFound: Boolean(binPath), version, authConfigured, notes };
  },

  async createSession(opts: SessionOptions): Promise<SessionHandle> {
    return { id: newSessionId(), agent: "claude", runtime: opts.runtime, cwd: opts.cwd };
  },

  async resumeSession(externalId: string, opts: SessionOptions): Promise<SessionHandle> {
    return {
      id: newSessionId(),
      agent: "claude",
      runtime: opts.runtime,
      cwd: opts.cwd,
      externalSessionId: externalId,
    };
  },

  send(session: SessionHandle, prompt: SendOptions): AsyncIterable<AgentEvent> {
    if (prompt.settings === "inline") {
      process.stderr.write(
        "[agentctl] note: --settings inline is not supported by Claude Code; project settings apply.\n",
      );
    }
    // In subprocess mode stdin is always ignored, so --approve none silently
    // denies every tool that would normally prompt for approval.
    if (!prompt.interactive && prompt.approve === "none") {
      process.stderr.write(
        "[agentctl] note: running with --approve none — agent tool use (shell, file edits) is denied. Pass --approve all to permit it.\n",
      );
    }

    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (session.externalSessionId) args.push("--resume", session.externalSessionId);
    if (prompt.model) args.push("--model", prompt.model);
    if (prompt.approve === "all") args.push("--permission-mode", "bypassPermissions");
    args.push("--");
    args.push(prompt.prompt);

    return runStreamJsonAgent({ agent: "claude", binary: BINARY, args, session, send: prompt });
  },

  async respondToApproval(_run: RunHandle, _decision: "allow" | "deny"): Promise<void> {
    throw new Error(
      "claude: interactive approval is not supported in headless mode. Use --approve all (bypassPermissions).",
    );
  },

  async cancel(run: RunHandle): Promise<void> {
    if (run.pgid !== undefined) {
      try { process.kill(-run.pgid, "SIGTERM"); } catch { /* already gone */ }
    } else if (run.pid !== undefined) {
      try { process.kill(run.pid, "SIGTERM"); } catch { /* already gone */ }
    } else {
      throw new Error("claude: no active process group to cancel.");
    }
  },
};

async function hasClaudeLogin(): Promise<boolean> {
  const candidates = [
    path.join(os.homedir(), ".claude", ".credentials.json"),
    path.join(os.homedir(), ".claude.json"),
    path.join(os.homedir(), ".config", "claude", ".credentials.json"),
  ];
  for (const file of candidates) {
    try {
      await fs.access(file);
      return true;
    } catch {
      // try next
    }
  }
  return false;
}
