import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function isWSL(): boolean {
  try {
    return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

/**
 * Copy text to the system clipboard. Returns true on success, false if no
 * clipboard utility was found (e.g. headless server). Never throws.
 */
export function copyToClipboard(text: string): boolean {
  const pipe = { input: text, stdio: ["pipe", "ignore", "ignore"] as ["pipe", "ignore", "ignore"] };
  try {
    if (process.platform === "darwin") {
      execSync("pbcopy", pipe);
      return true;
    }
    if (process.platform === "win32") {
      execSync("clip", pipe);
      return true;
    }
    // Linux — try WSL's clip.exe first, then xclip/xsel/wl-copy.
    if (isWSL()) {
      execSync("clip.exe", pipe);
      return true;
    }
    for (const cmd of [
      "xclip -selection clipboard",
      "xsel --clipboard --input",
      "wl-copy",
    ]) {
      try {
        execSync(cmd, pipe);
        return true;
      } catch {
        // try next
      }
    }
    return false;
  } catch {
    return false;
  }
}
