import select from "@inquirer/select";
import { listSessions, type SessionRecord } from "../sessionStore.js";

/**
 * Show an interactive dropdown to pick a session ID.
 *
 * @param filter   Optional predicate to restrict which sessions appear.
 * @param emptyMsg Error message when no sessions match the filter.
 *
 * Returns undefined when the user cancels (Ctrl-C / ExitPromptError).
 * Throws when no sessions match or stdin is not a TTY.
 */
export async function pickSession(
  filter?: (s: SessionRecord) => boolean,
  emptyMsg = "No sessions found.",
): Promise<string | undefined> {
  const all = await listSessions();
  const sessions = filter ? all.filter(filter) : all;
  if (sessions.length === 0) {
    throw new Error(emptyMsg);
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
