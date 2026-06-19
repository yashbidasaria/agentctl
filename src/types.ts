/**
 * Core type contracts for agentctl.
 *
 * The versioned `AgentEvent` stream is the product's stable contract — see
 * docs/ADAPTER.md for the compatibility policy.
 */

export const SCHEMA_VERSION = "0.1.0";

export type Runtime = "local" | "cloud";

export type ApprovePolicy = "none" | "all";

export type SettingSource = "inline" | "project" | "all";

export type OutputFormat = "text" | "json" | "stream-json";

/** Normalized event emitted by every adapter. `meta` is first; `done` is terminal. */
export type AgentEvent =
  | { type: "meta"; schemaVersion: string; agent: string; sessionId: string; runId: string }
  | { type: "reasoning"; text: string }
  | { type: "assistant_text"; text: string }
  | { type: "plan"; steps: string[] }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; output: unknown }
  | {
      type: "file_change";
      path: string;
      changeType: "create" | "modify" | "delete";
      patch?: string;
    }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: "status"; state: "running" | "waiting_approval" }
  | { type: "error"; message: string; retryable?: boolean }
  | {
      type: "done";
      outcome: "finished" | "error" | "cancelled" | "timeout";
      exitCode: number;
      result?: string;
    };

export type AgentEventType = AgentEvent["type"];

/** What a given adapter backend is able to do. Surfaced via `agents list`. */
export interface AdapterCapabilities {
  /** Multi-turn session resume across process restarts. */
  resume: boolean;
  /** Cloud runtime (e.g. Cursor `bc-` agents). */
  cloud: boolean;
  /** Streams tool_call / tool_result events. */
  toolStreaming: boolean;
  /** Honors a sandbox flag. */
  sandbox: boolean;
  /** Can pause for tool approval (waiting_approval + respondToApproval). */
  approvals: boolean;
  /** Optional event types this adapter may emit. */
  emits: AgentEventType[];
}

export interface ModelInfo {
  id: string;
  displayName?: string;
}

export interface DoctorReport {
  agent: string;
  /** Backing binary is installed and on PATH. */
  binaryFound: boolean;
  /** Resolved binary version, if detectable. */
  version?: string;
  /** Auth is configured (env var or saved login). */
  authConfigured: boolean;
  /** Human-readable notes / remediation hints. */
  notes: string[];
}

export interface SessionOptions {
  cwd: string;
  runtime: Runtime;
  model?: string;
  settings: SettingSource;
  sandbox?: boolean;
  approve: ApprovePolicy;
}

export interface SendOptions {
  prompt: string;
  approve: ApprovePolicy;
  timeoutSec?: number;
  /** Whether stdin is an interactive TTY (drives inline approval prompts). */
  interactive: boolean;
}

/** Durable handle to a conversation/work context. Mirrors the local session record. */
export interface SessionHandle {
  id: string;
  agent: string;
  runtime: Runtime;
  cwd: string;
  externalSessionId?: string;
}

/** Handle to a single in-flight prompt submission. */
export interface RunHandle {
  runId: string;
  sessionId: string;
  /** OS pid for subprocess-backed runs (enables cross-process cancel). */
  pid?: number;
  /** OS process-group id for subprocess-backed runs. */
  pgid?: number;
}

/**
 * The contract every backend implements. Each adapter owns the messy details:
 * flags, auth env vars, resume semantics, output parsing, and process lifecycle.
 */
export interface AgentAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;

  doctor(): Promise<DoctorReport>;
  createSession(opts: SessionOptions): Promise<SessionHandle>;
  resumeSession(externalId: string, opts: SessionOptions): Promise<SessionHandle>;
  send(session: SessionHandle, prompt: SendOptions): AsyncIterable<AgentEvent>;
  respondToApproval(run: RunHandle, decision: "allow" | "deny"): Promise<void>;
  cancel(run: RunHandle): Promise<void>;
  listModels?(): Promise<ModelInfo[]>;
}

/** Process exit codes (see docs). */
export const ExitCode = {
  Success: 0,
  StartupFailure: 1,
  RunFailed: 2,
  UserCancel: 3,
  Timeout: 4,
} as const;
