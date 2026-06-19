import { promises as fs } from "node:fs";
import path from "node:path";
import { agentctlHome, configPath } from "./paths.js";
import type { ApprovePolicy, Runtime, SettingSource } from "./types.js";

export interface AgentctlConfig {
  defaultAgent?: string;
  defaultRuntime: Runtime;
  defaultApprove: ApprovePolicy;
  defaultSettings: SettingSource;
}

const DEFAULT_CONFIG: AgentctlConfig = {
  defaultRuntime: "local",
  defaultApprove: "none",
  defaultSettings: "project",
};

export async function loadConfig(): Promise<AgentctlConfig> {
  try {
    const raw = await fs.readFile(configPath(), "utf8");
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<AgentctlConfig>) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw err;
  }
}

export async function saveConfig(config: AgentctlConfig): Promise<void> {
  await fs.mkdir(agentctlHome(), { recursive: true });
  const tmp = `${configPath()}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), "utf8");
  await fs.rename(tmp, configPath());
}

/** Dotted-key setter used by `agentctl config set`. */
export async function setConfigKey(key: string, value: string): Promise<AgentctlConfig> {
  const config = await loadConfig();
  switch (key) {
    case "default.agent":
      config.defaultAgent = value;
      break;
    case "default.runtime":
      config.defaultRuntime = value as Runtime;
      break;
    case "default.approve":
      config.defaultApprove = value as ApprovePolicy;
      break;
    case "default.settings":
      config.defaultSettings = value as SettingSource;
      break;
    default:
      throw new Error(`Unknown config key: ${key}`);
  }
  await saveConfig(config);
  return config;
}

export { configPath, agentctlHome, path };
