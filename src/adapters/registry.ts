import type { AgentAdapter } from "../types.js";
import { cursorAdapter } from "./cursor.js";
import { claudeAdapter } from "./claude.js";

const adapters: Record<string, AgentAdapter> = {
  [cursorAdapter.name]: cursorAdapter,
  [claudeAdapter.name]: claudeAdapter,
};

export function getAdapter(name: string): AgentAdapter {
  const adapter = adapters[name];
  if (!adapter) {
    throw new Error(
      `Unknown agent: ${name}. Available: ${Object.keys(adapters).join(", ")}`,
    );
  }
  return adapter;
}

export function listAdapters(): AgentAdapter[] {
  return Object.values(adapters);
}
