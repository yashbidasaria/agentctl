import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Resolve a binary on PATH; returns its path or undefined. */
export async function which(bin: string): Promise<string | undefined> {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(finder, [bin]);
    const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    return first?.trim();
  } catch {
    return undefined;
  }
}

/** Run a binary and capture trimmed stdout (e.g. for `--version`). */
export async function tryVersion(bin: string, args: string[] = ["--version"]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: 5000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
