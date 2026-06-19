import os from "node:os";
import path from "node:path";

/** Root config/state dir: ~/.agentctl (override with AGENTCTL_HOME). */
export function agentctlHome(): string {
  return process.env.AGENTCTL_HOME ?? path.join(os.homedir(), ".agentctl");
}

export function configPath(): string {
  return path.join(agentctlHome(), "config.json");
}

export function sessionsDir(): string {
  return path.join(agentctlHome(), "sessions");
}

export function sessionPath(id: string): string {
  return path.join(sessionsDir(), `${id}.json`);
}
