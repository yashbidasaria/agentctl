import select from "@inquirer/select";
import { listSessions } from "../sessionStore.js";

/**
 * Show an interactive dropdown to pick a session ID.
 * Returns undefined when the user cancels (Ctrl-C / ExitPromptError) or when
 * stdin is not a TTY and no sessions were pre-filtered in.
 * Throws when there are no sessions at all.
 */
export async function pickSession(): Promise<string | undefined> {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    throw new Error("No sessions found.");
  }
  if (!process.stdin.isTTY) {
    throw new Error("No session id provided and stdin is not a TTY (cannot show picker).");
  }
  try {
    return await select({
      message: "Select a session",
      choices: sessions.map((s) => ({
        name: `${s.id}  ${s.agent.padEnd(8)} ${s.status.padEnd(16)} ${s.cwd}`,
        value: s.id,
      })),
      pageSize: Math.min(sessions.length, 10),
    });
  } catch (err) {
    if ((err as Error).name === "ExitPromptError") return undefined;
    throw err;
  }
}
