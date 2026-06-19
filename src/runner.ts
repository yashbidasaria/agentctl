import path from "node:path";
import readline from "node:readline";
import { getAdapter } from "./adapters/registry.js";
import { loadConfig } from "./config.js";
import { OutputWriter } from "./output.js";
import {
  createSession as persistSession,
  newSessionId,
  readSession,
  updateSession,
  type SessionRecord,
} from "./sessionStore.js";
import {
  ExitCode,
  type ApprovePolicy,
  type OutputFormat,
  type Runtime,
  type SendOptions,
  type SessionHandle,
  type SettingSource,
} from "./types.js";

export interface CommonRunFlags {
  agent?: string;
  cwd?: string;
  runtime?: Runtime;
  approve?: ApprovePolicy;
  settings?: SettingSource;
  sandbox?: string;
  model?: string;
  timeout?: number;
  format?: OutputFormat;
}

interface Resolved {
  agentName: string;
  cwd: string;
  runtime: Runtime;
  approve: ApprovePolicy;
  settings: SettingSource;
  sandbox?: boolean;
  model?: string;
  timeoutSec?: number;
  format: OutputFormat;
}

async function resolve(flags: CommonRunFlags): Promise<Resolved> {
  const config = await loadConfig();
  const agentName = flags.agent ?? config.defaultAgent ?? "";
  if (!agentName) {
    throw new StartupError("No agent specified. Pass --agent or set `config set default.agent`.");
  }
  let sandbox: boolean | undefined;
  if (flags.sandbox === "enabled") sandbox = true;
  else if (flags.sandbox === "disabled") sandbox = false;
  else if (flags.sandbox !== undefined) throw new StartupError("--sandbox must be 'enabled' or 'disabled'.");

  return {
    agentName,
    cwd: path.resolve(flags.cwd ?? process.cwd()),
    runtime: flags.runtime ?? config.defaultRuntime,
    approve: flags.approve ?? config.defaultApprove,
    settings: flags.settings ?? config.defaultSettings,
    sandbox,
    model: flags.model,
    timeoutSec: flags.timeout,
    format: flags.format ?? "text",
  };
}

export class StartupError extends Error {}

/** Stream a session handle through an adapter, render output, return exit code. */
async function stream(
  agentName: string,
  handle: SessionHandle,
  sendOpts: SendOptions,
  format: OutputFormat,
): Promise<number> {
  const adapter = getAdapter(agentName);
  if (handle.runtime === "cloud" && !adapter.capabilities.cloud) {
    throw new StartupError(`Agent '${agentName}' does not support --runtime cloud.`);
  }
  if (sendOpts.sandbox !== undefined && !adapter.capabilities.sandbox) {
    throw new StartupError(`Agent '${agentName}' does not support --sandbox.`);
  }
  if (sendOpts.approve === "all" && sendOpts.sandbox !== true) {
    process.stderr.write(
      "[agentctl] WARNING: --approve all permits arbitrary commands without a sandbox.\n",
    );
  }

  const writer = new OutputWriter(format);
  let exitCode: number = ExitCode.Success;

  // On SIGINT/SIGTERM: kill the subprocess and mark the session idle before
  // exiting so `session list` immediately shows the correct state.
  const cleanupOnSignal = async () => {
    const rec = await readSession(handle.id).catch(() => undefined);
    if (rec?.pgid) { try { process.kill(-rec.pgid, "SIGTERM"); } catch { /* gone */ } }
    else if (rec?.pid) { try { process.kill(rec.pid, "SIGTERM"); } catch { /* gone */ } }
    await updateSession(handle.id, (r) => {
      r.status = "idle";
      r.busy = false;
      r.pid = undefined;
      r.pgid = undefined;
    }).catch(() => {});
    process.exit(ExitCode.UserCancel);
  };
  const sigHandler = () => { void cleanupOnSignal(); };
  process.once("SIGINT", sigHandler);
  process.once("SIGTERM", sigHandler);

  try {
    for await (const event of adapter.send(handle, sendOpts)) {
      writer.write(event);
      if (event.type === "done") exitCode = event.exitCode;
    }
  } finally {
    process.removeListener("SIGINT", sigHandler);
    process.removeListener("SIGTERM", sigHandler);
  }
  return exitCode;
}

/** `agentctl run` — one-shot synchronous prompt. */
export async function runOnce(promptText: string, flags: CommonRunFlags): Promise<number> {
  const r = await resolve(flags);
  const sessionId = newSessionId();
  await persistSession({ id: sessionId, agent: r.agentName, runtime: r.runtime, cwd: r.cwd });
  const handle: SessionHandle = {
    id: sessionId,
    agent: r.agentName,
    runtime: r.runtime,
    cwd: r.cwd,
  };
  return stream(r.agentName, handle, buildSendOptions(promptText, r), r.format);
}

/** `agentctl session create` — persist a session and print its id. */
export async function sessionCreate(flags: CommonRunFlags): Promise<string> {
  const r = await resolve(flags);
  const sessionId = newSessionId();
  await persistSession({ id: sessionId, agent: r.agentName, runtime: r.runtime, cwd: r.cwd });
  return sessionId;
}

/** `agentctl session send` — send a prompt to an existing session. */
export async function sessionSend(
  id: string,
  promptText: string,
  flags: CommonRunFlags,
): Promise<number> {
  const rec = await readSession(id);
  if (!rec) throw new StartupError(`Session not found: ${id}`);

  const r = await resolve({ ...flags, agent: rec.agent, cwd: rec.cwd, runtime: rec.runtime });
  const handle: SessionHandle = {
    id: rec.id,
    agent: rec.agent,
    runtime: rec.runtime,
    cwd: rec.cwd,
    externalSessionId: rec.externalSessionId,
  };
  // Atomic check-and-set: busy check and write happen under the same lock,
  // preventing two concurrent sends from both passing the guard.
  await updateSession(id, (x) => {
    if (x.busy) throw new StartupError(`Session ${id} is busy (a run is in progress).`);
    x.busy = true;
  });
  try {
    return await stream(rec.agent, handle, buildSendOptions(promptText, r), r.format);
  } finally {
    try {
      await updateSession(id, (x) => {
        x.busy = false;
      });
    } catch {
      // Swallow errors here so the run's original result is not replaced.
    }
  }
}

/** `agentctl session resume <id>` — reset a stuck session so it can accept new sends. */
export async function sessionResume(id: string): Promise<SessionRecord> {
  const rec = await readSession(id);
  if (!rec) throw new StartupError(`Session not found: ${id}`);
  if (rec.busy) throw new StartupError(`Session ${id} is busy — a run is already in progress.`);
  if (rec.status === "running" || rec.status === "error" || rec.status === "timeout") {
    return updateSession(id, (r) => {
      r.status = "idle";
      r.pid = undefined;
      r.pgid = undefined;
    });
  }
  return rec;
}

/**
 * `agentctl session follow <id>` — poll the session record until the run finishes.
 *
 * v1 limitation: only session-level status is visible, not the full event stream.
 * Full event streaming requires the run to be active in the same process.
 */
export async function sessionFollow(
  id: string,
  pollMs = 500,
  onStatus?: (status: string) => void,
): Promise<SessionRecord> {
  const initial = await readSession(id);
  if (!initial) throw new StartupError(`Session not found: ${id}`);

  const active = new Set(["running", "waiting_approval"]);
  if (!active.has(initial.status)) return initial;

  let last = initial.status;
  onStatus?.(last);
  for (;;) {
    await new Promise<void>((r) => setTimeout(r, pollMs));
    const rec = await readSession(id);
    if (!rec) throw new StartupError(`Session ${id} disappeared while following.`);
    if (rec.status !== last) {
      last = rec.status;
      onStatus?.(last);
    }
    if (!active.has(rec.status)) return rec;
  }
}

/** `agentctl session approve <id> --allow|--deny` — respond to a waiting_approval. */
export async function sessionApprove(id: string, decision: "allow" | "deny"): Promise<void> {
  const rec = await readSession(id);
  if (!rec) throw new StartupError(`Session not found: ${id}`);
  if (rec.status !== "waiting_approval") {
    throw new StartupError(
      `Session ${id} is not waiting for approval (status: ${rec.status}).`,
    );
  }
  const adapter = getAdapter(rec.agent);
  const runHandle = {
    runId: rec.lastRunId ?? "",
    sessionId: id,
    pid: rec.pid,
    pgid: rec.pgid,
  };
  await adapter.respondToApproval(runHandle, decision);
  if (decision === "deny") {
    await updateSession(id, (r) => {
      r.status = "idle";
      r.pid = undefined;
      r.pgid = undefined;
    });
  }
}

/** `agentctl session cancel` — signal an active run from any process. */
export async function sessionCancel(id: string): Promise<void> {
  const rec = await readSession(id);
  if (!rec) throw new StartupError(`Session not found: ${id}`);
  if (rec.pgid === undefined && rec.pid === undefined) {
    throw new StartupError(`Session ${id} has no active run to cancel.`);
  }
  const adapter = getAdapter(rec.agent);
  await adapter.cancel({ runId: rec.lastRunId ?? "", sessionId: id, pid: rec.pid, pgid: rec.pgid });
  // Write updated status immediately so subsequent `session list` reflects the
  // cancel without waiting for the subprocess to exit and clean up itself.
  await updateSession(id, (r) => {
    r.status = "idle";
    r.busy = false;
    r.pid = undefined;
    r.pgid = undefined;
  });
}

/**
 * `agentctl session list` (interactive) — enter a REPL for an existing session.
 *
 * Reads prompts from stdin, calls sessionSend for each, prints only the final
 * result. `:quit`, `:q`, or Ctrl-D exit the REPL.
 */
export async function sessionInteractive(id: string): Promise<void> {
  const rec = await readSession(id);
  if (!rec) throw new StartupError(`Session not found: ${id}`);

  const shortId = id.slice(0, 16);
  process.stderr.write(`\nSession ${id} (${rec.agent} · ${rec.cwd})\nType :quit to exit.\n\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl.setPrompt(`[${shortId}] > `);
  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (!input) { rl.prompt(); continue; }
    if (input === ":quit" || input === ":q" || input === "exit") break;
    try {
      await sessionSend(id, input, { approve: "all", format: "result" });
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
    }
    process.stdout.write("\n");
    rl.prompt();
  }

  rl.close();
}

function buildSendOptions(promptText: string, r: Resolved): SendOptions {
  return {
    prompt: promptText,
    approve: r.approve,
    settings: r.settings,
    model: r.model,
    sandbox: r.sandbox,
    timeoutSec: r.timeoutSec,
    interactive: Boolean(process.stdin.isTTY),
  };
}
