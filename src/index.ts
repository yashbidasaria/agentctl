#!/usr/bin/env node
import { Command, Option } from "commander";
import { loadConfig, setConfigKey } from "./config.js";
import { listAdapters } from "./adapters/registry.js";
import { listSessions, readSession, type SessionRecord } from "./sessionStore.js";
import { ExitCode, type OutputFormat, type Runtime, type ApprovePolicy, type SettingSource } from "./types.js";
import { copyToClipboard } from "./util/clipboard.js";
import { pickSession } from "./util/selectSession.js";
import {
  runOnce,
  sessionApprove,
  sessionCancel,
  sessionCreate,
  sessionFollow,
  sessionInteractive,
  sessionResume,
  sessionSend,
  StartupError,
  type CommonRunFlags,
} from "./runner.js";

interface RawRunFlags {
  agent?: string;
  cwd?: string;
  runtime?: string;
  approve?: string;
  settings?: string;
  sandbox?: string;
  model?: string;
  timeout?: number;
  format?: string;
}

function toFlags(o: RawRunFlags): CommonRunFlags {
  return {
    agent: o.agent,
    cwd: o.cwd,
    runtime: o.runtime as Runtime | undefined,
    approve: o.approve as ApprovePolicy | undefined,
    settings: o.settings as SettingSource | undefined,
    sandbox: o.sandbox,
    model: o.model,
    timeout: o.timeout,
    format: o.format as OutputFormat | undefined,
  };
}

function fail(err: unknown): void {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = err instanceof StartupError ? ExitCode.StartupFailure : ExitCode.RunFailed;
}

const program = new Command();

program
  .name("agentctl")
  .description("Control plane for coding agent CLIs — one command surface, one event stream.")
  .version("0.0.1");

const agents = program.command("agents").description("Discover and inspect agent backends");

agents
  .command("list")
  .description("List available agent adapters and their capabilities")
  .action(() => {
    for (const adapter of listAdapters()) {
      const c = adapter.capabilities;
      const caps = [
        c.resume && "resume",
        c.cloud && "cloud",
        c.toolStreaming && "tools",
        c.sandbox && "sandbox",
        c.approvals && "approvals",
      ]
        .filter(Boolean)
        .join(", ");
      console.log(`${adapter.name.padEnd(8)} ${caps}`);
    }
  });

agents
  .command("doctor")
  .description("Check that agent binaries are installed and authenticated")
  .action(async () => {
    let healthy = true;
    for (const adapter of listAdapters()) {
      const report = await adapter.doctor();
      const ok = report.binaryFound && report.authConfigured;
      healthy = healthy && ok;
      const mark = ok ? "ok" : "!!";
      console.log(`[${mark}] ${report.agent}${report.version ? ` (${report.version})` : ""}`);
      console.log(`     binary: ${report.binaryFound ? "found" : "missing"}, auth: ${report.authConfigured ? "configured" : "missing"}`);
      for (const note of report.notes) console.log(`     - ${note}`);
    }
    if (!healthy) process.exitCode = ExitCode.StartupFailure;
  });

const config = program.command("config").description("View and set agentctl configuration");

config
  .command("get")
  .description("Print the current configuration")
  .action(async () => {
    console.log(JSON.stringify(await loadConfig(), null, 2));
  });

config
  .command("set <key> <value>")
  .description("Set a config key (e.g. default.agent cursor)")
  .action(async (key: string, value: string) => {
    try {
      const updated = await setConfigKey(key, value);
      console.log(JSON.stringify(updated, null, 2));
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = ExitCode.StartupFailure;
    }
  });

program
  .command("run")
  .description("Run a one-shot prompt against an agent (synchronous)")
  .requiredOption("-p, --prompt <text>", "prompt to send")
  .option("--agent <name>", "agent backend (defaults to configured default)")
  .option("--cwd <dir>", "working directory", process.cwd())
  .addOption(new Option("--runtime <runtime>", "execution runtime").choices(["local", "cloud"]))
  .addOption(new Option("--approve <policy>", "non-interactive approval policy").choices(["none", "all"]))
  .addOption(new Option("--settings <source>", "which settings to load").choices(["inline", "project", "all"]))
  .addOption(new Option("--format <format>", "output format").choices(["text", "json", "stream-json", "result"]).default("text"))
  .option("--sandbox <mode>", "sandbox mode (enabled|disabled)")
  .option("--model <id>", "agent-specific model id")
  .option("--timeout <sec>", "timeout in seconds", (v) => Number.parseInt(v, 10))
  .action(async (opts: RawRunFlags & { prompt: string }) => {
    try {
      process.exitCode = await runOnce(opts.prompt, toFlags(opts));
    } catch (err) {
      fail(err);
    }
  });

const session = program.command("session").description("Manage durable multi-turn sessions");

/**
 * Resolve an optional session id: return it as-is when provided, otherwise
 * show the interactive picker filtered to matching sessions.
 * Returns undefined when the user cancels.
 */
async function resolveSession(
  id: string | undefined,
  filter?: (s: SessionRecord) => boolean,
  emptyMsg?: string,
): Promise<string | undefined> {
  return id ?? pickSession(filter, emptyMsg);
}

const isActive = (s: SessionRecord) => s.status !== "idle";

session
  .command("list")
  .description("List active sessions; pick one to enter an interactive REPL (TTY only)")
  .option("--all", "include idle (completed) sessions")
  .action(async (opts: { all?: boolean }) => {
    const all = await listSessions();
    const sessions = opts.all ? all : all.filter(isActive);
    const emptyMsg = opts.all
      ? "No sessions yet."
      : "No active sessions (use --all to include completed ones).";
    if (sessions.length === 0) {
      console.log(emptyMsg);
      return;
    }
    if (!process.stdin.isTTY) {
      for (const s of sessions) {
        console.log(`${s.id}  ${s.agent.padEnd(8)} ${s.status.padEnd(16)} ${s.cwd}`);
      }
      return;
    }
    const id = await pickSession(opts.all ? undefined : isActive, emptyMsg);
    if (!id) return;
    await sessionInteractive(id).catch(fail);
  });

session
  .command("show [id]")
  .description("Show a single session record (picker if id omitted)")
  .action(async (id: string | undefined) => {
    const resolved = await resolveSession(id).catch(fail);
    if (!resolved) return;
    const rec = await readSession(resolved);
    if (!rec) {
      console.error(`Session not found: ${resolved}`);
      process.exitCode = ExitCode.StartupFailure;
      return;
    }
    console.log(JSON.stringify(rec, null, 2));
  });

session
  .command("create")
  .description("Create a new session and print its id (copies to clipboard)")
  .option("--agent <name>", "agent backend (defaults to configured default)")
  .option("--cwd <dir>", "working directory", process.cwd())
  .addOption(new Option("--runtime <runtime>", "execution runtime").choices(["local", "cloud"]))
  .action(async (opts: RawRunFlags) => {
    try {
      const id = await sessionCreate(toFlags(opts));
      console.log(id);
      const copied = copyToClipboard(id);
      if (copied) process.stderr.write("[agentctl] session id copied to clipboard\n");
    } catch (err) {
      fail(err);
    }
  });

session
  .command("send [id] [prompt]")
  .description("Send a prompt to a session (picker if id omitted; REPL if prompt omitted)")
  .addOption(new Option("--approve <policy>", "non-interactive approval policy").choices(["none", "all"]).default("all"))
  .addOption(new Option("--format <format>", "output format").choices(["text", "json", "stream-json", "result"]).default("result"))
  .option("--model <id>", "agent-specific model id")
  .option("--sandbox <mode>", "sandbox mode (enabled|disabled)")
  .option("--timeout <sec>", "timeout in seconds", (v) => Number.parseInt(v, 10))
  .action(async (id: string | undefined, prompt: string | undefined, opts: RawRunFlags) => {
    try {
      const resolved = await resolveSession(id, undefined, "No sessions found.");
      if (!resolved) return;
      if (!prompt) {
        await sessionInteractive(resolved);
      } else {
        process.exitCode = await sessionSend(resolved, prompt, toFlags(opts));
      }
    } catch (err) {
      fail(err);
    }
  });

session
  .command("cancel [id]")
  .description("Cancel the active run of a session (picker if id omitted)")
  .action(async (id: string | undefined) => {
    try {
      const resolved = await resolveSession(
        id,
        (s) => s.status === "running" || s.busy,
        "No running sessions to cancel.",
      );
      if (!resolved) return;
      await sessionCancel(resolved);
      console.log(`Cancelled ${resolved}.`);
    } catch (err) {
      fail(err);
    }
  });

session
  .command("resume [id]")
  .description("Reset a stuck/errored session to idle (picker if id omitted)")
  .action(async (id: string | undefined) => {
    try {
      const resolved = await resolveSession(
        id,
        (s) => s.status !== "idle",
        "No stuck/errored sessions to resume.",
      );
      if (!resolved) return;
      const rec = await sessionResume(resolved);
      console.log(JSON.stringify(rec, null, 2));
    } catch (err) {
      fail(err);
    }
  });

session
  .command("follow [id]")
  .description("Poll a running session until it finishes (picker if id omitted)")
  .action(async (id: string | undefined) => {
    try {
      const resolved = await resolveSession(
        id,
        (s) => s.status === "running" || s.status === "waiting_approval",
        "No running sessions to follow.",
      );
      if (!resolved) return;
      const rec = await sessionFollow(resolved, 500, (status) => {
        process.stderr.write(`[agentctl] session status: ${status}\n`);
      });
      console.log(JSON.stringify(rec, null, 2));
    } catch (err) {
      fail(err);
    }
  });

session
  .command("approve [id]")
  .description("Respond to a waiting_approval (picker if id omitted)")
  .addOption(
    new Option("--decision <decision>", "approval decision").choices(["allow", "deny"]).default("allow"),
  )
  .action(async (id: string | undefined, opts: { decision: string }) => {
    try {
      const resolved = await resolveSession(
        id,
        (s) => s.status === "waiting_approval",
        "No sessions waiting for approval.",
      );
      if (!resolved) return;
      await sessionApprove(resolved, opts.decision as "allow" | "deny");
      console.log(`${opts.decision === "allow" ? "Approved" : "Denied"}: ${resolved}`);
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(ExitCode.StartupFailure);
});
