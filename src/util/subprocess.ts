import { spawn } from "node:child_process";
import readline from "node:readline";

export interface LineStreamState {
  timedOut: boolean;
  exited: boolean;
  exitCode: number | null;
}

export interface LineStream {
  /** OS pid of the child. */
  pid: number;
  /**
   * OS process-group id. Because the child is spawned `detached`, it leads its
   * own group (pgid === pid), so signalling `-pgid` reaches the whole tree.
   */
  pgid: number;
  /** Async iterable of non-empty stdout lines. */
  lines: AsyncIterable<string>;
  /** Mutable status, updated as the process runs. */
  state: LineStreamState;
  /** Signal the entire process group. */
  kill(signal?: NodeJS.Signals): void;
}

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Spawn a binary in its own process group and stream stdout line-by-line.
 *
 * Guarantees no orphaned children: the process leads its own group and is
 * killed via the group; `agentctl`'s top-level SIGINT/SIGTERM handlers also
 * call `kill()`. On timeout the group is SIGKILLed and `state.timedOut` is set.
 */
export function spawnLineStream(bin: string, args: string[], opts: SpawnOptions = {}): LineStream {
  const child = spawn(bin, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  });

  const pid = child.pid;
  if (pid === undefined) throw new Error(`Failed to spawn ${bin}`);
  const pgid = pid;

  const state: LineStreamState = { timedOut: false, exited: false, exitCode: null };

  const kill = (signal: NodeJS.Signals = "SIGTERM"): void => {
    try {
      process.kill(-pgid, signal);
    } catch {
      // group already gone
    }
  };

  const timer =
    opts.timeoutMs != null
      ? setTimeout(() => {
          state.timedOut = true;
          kill("SIGKILL");
        }, opts.timeoutMs).unref()
      : undefined;

  child.on("exit", (code) => {
    state.exited = true;
    state.exitCode = code;
    if (timer) clearTimeout(timer);
  });

  async function* lineGenerator(): AsyncGenerator<string> {
    const stdout = child.stdout;
    if (!stdout) return;
    const rl = readline.createInterface({ input: stdout, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (line.trim().length > 0) yield line;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { pid, pgid, lines: lineGenerator(), state, kill };
}
