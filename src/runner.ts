import path from "node:path";
import { getAdapter } from "./adapters/registry.js";
import { loadConfig } from "./config.js";
import { OutputWriter } from "./output.js";
import {
  createSession as persistSession,
  newSessionId,
  readSession,
  updateSession,
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
  for await (const event of adapter.send(handle, sendOpts)) {
    writer.write(event);
    if (event.type === "done") exitCode = event.exitCode;
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

/** `agentctl session cancel` — signal an active run from any process. */
export async function sessionCancel(id: string): Promise<void> {
  const rec = await readSession(id);
  if (!rec) throw new StartupError(`Session not found: ${id}`);
  if (rec.pgid === undefined && rec.pid === undefined) {
    throw new StartupError(`Session ${id} has no active run to cancel.`);
  }
  const adapter = getAdapter(rec.agent);
  await adapter.cancel({ runId: rec.lastRunId ?? "", sessionId: id, pid: rec.pid, pgid: rec.pgid });
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
