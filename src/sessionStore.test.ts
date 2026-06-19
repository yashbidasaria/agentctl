import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { collect, withTempHome } from "./test/helpers.js";
import { createSession, readSession, updateSession } from "./sessionStore.js";
import { StartupError, sessionSend } from "./runner.js";
import * as registry from "./adapters/registry.js";
import type { AgentAdapter } from "./types.js";

describe("sessionStore", () => {
  it("updateSession throws when session does not exist", async () => {
    await withTempHome(async () => {
      await expect(updateSession("sess_missing", (r) => { r.busy = true; })).rejects.toThrow(
        "Session not found: sess_missing",
      );
    });
  });

  it("persists busy flag and pid/pgid across updates", async () => {
    await withTempHome(async () => {
      const rec = await createSession({
        id: "sess_test1",
        agent: "cursor",
        runtime: "local",
        cwd: "/tmp",
      });
      expect(rec.busy).toBe(false);

      await updateSession(rec.id, (r) => {
        r.busy = true;
        r.pid = 999;
        r.pgid = 999;
        r.status = "running";
      });

      const updated = await readSession(rec.id);
      expect(updated?.busy).toBe(true);
      expect(updated?.pid).toBe(999);
      expect(updated?.pgid).toBe(999);
      expect(updated?.status).toBe("running");
    });
  });

  it("serializes concurrent updates under the file lock", async () => {
    await withTempHome(async () => {
      await createSession({ id: "sess_race", agent: "cursor", runtime: "local", cwd: "/tmp" });

      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          updateSession("sess_race", (r) => {
            r.lastRunId = `run_${i}`;
          }),
        ),
      );

      const final = await readSession("sess_race");
      expect(final?.lastRunId).toMatch(/^run_\d$/);
    });
  });
});

describe("sessionSend busy guard", () => {
  let getAdapterSpy: ReturnType<typeof vi.spyOn>;

  const slowAdapter: AgentAdapter = {
    name: "mock",
    capabilities: {
      resume: false,
      cloud: false,
      toolStreaming: false,
      sandbox: false,
      approvals: false,
      emits: [],
    },
    doctor: async () => ({ agent: "mock", binaryFound: true, authConfigured: true, notes: [] }),
    createSession: async () => ({ id: "x", agent: "mock", runtime: "local", cwd: "/tmp" }),
    resumeSession: async () => ({ id: "x", agent: "mock", runtime: "local", cwd: "/tmp" }),
    async *send() {
      await new Promise((r) => setTimeout(r, 300));
      yield { type: "done", outcome: "finished", exitCode: 0, result: "ok" };
    },
    respondToApproval: async () => {},
    cancel: async () => {},
  };

  beforeEach(() => {
    getAdapterSpy = vi.spyOn(registry, "getAdapter").mockReturnValue(slowAdapter);
  });

  afterEach(() => {
    getAdapterSpy.mockRestore();
  });

  it("rejects a second concurrent send to the same session", async () => {
    await withTempHome(async () => {
      let releaseFirst!: () => void;
      const firstStarted = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      getAdapterSpy.mockReturnValue({
        ...slowAdapter,
        async *send() {
          releaseFirst();
          await new Promise((r) => setTimeout(r, 400));
          yield { type: "done", outcome: "finished", exitCode: 0, result: "ok" };
        },
      });

      await createSession({ id: "sess_busy", agent: "mock", runtime: "local", cwd: "/tmp" });

      const first = sessionSend("sess_busy", "first", { agent: "mock" });
      await firstStarted;

      await expect(sessionSend("sess_busy", "second", { agent: "mock" })).rejects.toThrow(StartupError);
      await expect(sessionSend("sess_busy", "second", { agent: "mock" })).rejects.toThrow(/busy/);

      await first;

      const cleared = await readSession("sess_busy");
      expect(cleared?.busy).toBe(false);
    });
  });
});
