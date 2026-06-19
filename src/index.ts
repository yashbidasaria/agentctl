#!/usr/bin/env node
import { Command, Option } from "commander";
import { loadConfig, setConfigKey } from "./config.js";
import { listAdapters } from "./adapters/registry.js";
import { listSessions, readSession } from "./sessionStore.js";
import { ExitCode, type OutputFormat, type Runtime, type ApprovePolicy, type SettingSource } from "./types.js";
import {
  runOnce,
  sessionCancel,
  sessionCreate,
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
  .addOption(new Option("--format <format>", "output format").choices(["text", "json", "stream-json"]).default("text"))
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

session
  .command("list")
  .description("List known sessions")
  .action(async () => {
    const sessions = await listSessions();
    if (sessions.length === 0) {
      console.log("No sessions yet.");
      return;
    }
    for (const s of sessions) {
      console.log(`${s.id}  ${s.agent.padEnd(8)} ${s.status.padEnd(16)} ${s.cwd}`);
    }
  });

session
  .command("show <id>")
  .description("Show a single session record")
  .action(async (id: string) => {
    const rec = await readSession(id);
    if (!rec) {
      console.error(`Session not found: ${id}`);
      process.exitCode = ExitCode.StartupFailure;
      return;
    }
    console.log(JSON.stringify(rec, null, 2));
  });

session
  .command("create")
  .description("Create a new session and print its id")
  .option("--agent <name>", "agent backend (defaults to configured default)")
  .option("--cwd <dir>", "working directory", process.cwd())
  .addOption(new Option("--runtime <runtime>", "execution runtime").choices(["local", "cloud"]))
  .action(async (opts: RawRunFlags) => {
    try {
      const id = await sessionCreate(toFlags(opts));
      console.log(id);
    } catch (err) {
      fail(err);
    }
  });

session
  .command("send <id> <prompt>")
  .description("Send a prompt to an existing session")
  .addOption(new Option("--approve <policy>", "non-interactive approval policy").choices(["none", "all"]))
  .addOption(new Option("--format <format>", "output format").choices(["text", "json", "stream-json"]).default("text"))
  .option("--model <id>", "agent-specific model id")
  .option("--sandbox <mode>", "sandbox mode (enabled|disabled)")
  .option("--timeout <sec>", "timeout in seconds", (v) => Number.parseInt(v, 10))
  .action(async (id: string, prompt: string, opts: RawRunFlags) => {
    try {
      process.exitCode = await sessionSend(id, prompt, toFlags(opts));
    } catch (err) {
      fail(err);
    }
  });

session
  .command("cancel <id>")
  .description("Cancel the active run of a session")
  .action(async (id: string) => {
    try {
      await sessionCancel(id);
      console.log(`Cancelled ${id}.`);
    } catch (err) {
      fail(err);
    }
  });

for (const [name, summary] of [
  ["follow", "Stream events from an active session"],
  ["resume", "Resume an existing session"],
  ["approve", "Respond to a waiting_approval"],
] as const) {
  session
    .command(`${name} [args...]`)
    .description(`${summary} (not implemented yet)`)
    .action(() => {
      console.error(`session ${name}: not implemented yet.`);
      process.exitCode = ExitCode.StartupFailure;
    });
}

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(ExitCode.StartupFailure);
});
