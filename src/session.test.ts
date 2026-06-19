import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withTempHome } from "./test/helpers.js";
import { createSession, readSession, updateSession } from "./sessionStore.js";
import { StartupError, sessionResume, sessionFollow, sessionApprove } from "./runner.js";
import * as registry from "./adapters/registry.js";
import type { AgentAdapter } from "./types.js";

const baseAdapter: AgentAdapter = {
  name: "mock",
  capabilities: {
    resume: false,
    cloud: false,
    toolStreaming: false,
    sandbox: false,
    approvals: true,
    emits: [],
  },
  doctor: async () => ({ agent: "mock", binaryFound: true, authConfigured: true, notes: [] }),
  createSession: async () => ({ id: "x", agent: "mock", runtime: "local", cwd: "/tmp" }),
  resumeSession: async () => ({ id: "x", agent: "mock", runtime: "local", cwd: "/tmp" }),
  async *send() {
    yield { type: "done", outcome: "finished", exitCode: 0, result: "ok" };
  },
  respondToApproval: vi.fn(async () => {}),
  cancel: async () => {},
};

let getAdapterSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getAdapterSpy = vi.spyOn(registry, "getAdapter").mockReturnValue(baseAdapter);
});

afterEach(() => {
  getAdapterSpy.mockRestore();
  vi.mocked(baseAdapter.respondToApproval).mockClear();
});

describe("sessionResume", () => {
  it("throws StartupError when session does not exist", async () => {
    await withTempHome(async () => {
      await expect(sessionResume("sess_missing")).rejects.toThrow(StartupError);
    });
  });

  it("throws StartupError when session is busy", async () => {
    await withTempHome(async () => {
      await createSession({ id: "sess_busy", agent: "mock", runtime: "local", cwd: "/tmp" });
      await updateSession("sess_busy", (r) => { r.busy = true; });
      await expect(sessionResume("sess_busy")).rejects.toThrow(/busy/);
    });
  });

  it("resets a running session to idle and clears pid/pgid", async () => {
    await withTempHome(async () => {
      await createSession({ id: "sess_stuck", agent: "mock", runtime: "local", cwd: "/tmp" });
      await updateSession("sess_stuck", (r) => {
        r.status = "running";
        r.pid = 9999;
        r.pgid = 9999;
      });

      const rec = await sessionResume("sess_stuck");
      expect(rec.status).toBe("idle");
      expect(rec.pid).toBeUndefined();
      expect(rec.pgid).toBeUndefined();
    });
  });

  it("resets an error session to idle", async () => {
    await withTempHome(async () => {
      await createSession({ id: "sess_err", agent: "mock", runtime: "local", cwd: "/tmp" });
      await updateSession("sess_err", (r) => { r.status = "error"; });
      const rec = await sessionResume("sess_err");
      expect(rec.status).toBe("idle");
    });
  });

  it("returns idle session unchanged", async () => {
    await withTempHome(async () => {
      await createSession({ id: "sess_idle", agent: "mock", runtime: "local", cwd: "/tmp" });
      const rec = await sessionResume("sess_idle");
      expect(rec.status).toBe("idle");
    });
  });
});

describe("sessionFollow", () => {
  it("throws StartupError when session does not exist", async () => {
    await withTempHome(async () => {
      await expect(sessionFollow("sess_missing")).rejects.toThrow(StartupError);
    });
  });

  it("returns immediately when session is not running", async () => {
    await withTempHome(async () => {
      await createSession({ id: "sess_done", agent: "mock", runtime: "local", cwd: "/tmp" });
      const rec = await sessionFollow("sess_done");
      expect(rec.status).toBe("idle");
    });
  });

  it("polls until status leaves active state", async () => {
    await withTempHome(async () => {
      await createSession({ id: "sess_running", agent: "mock", runtime: "local", cwd: "/tmp" });
      await updateSession("sess_running", (r) => { r.status = "running"; r.pid = 123; });

      // After two polls, flip the session to idle in background.
      let polls = 0;
      const statuses: string[] = [];
      const followPromise = sessionFollow("sess_running", 20, (s) => {
        statuses.push(s);
        polls++;
        if (polls === 1) {
          // Simulate the run finishing after the first poll sees "running".
          void updateSession("sess_running", (r) => { r.status = "idle"; r.pid = undefined; });
        }
      });

      const rec = await followPromise;
      expect(rec.status).toBe("idle");
      expect(statuses[0]).toBe("running");
    });
  });
});

describe("sessionApprove", () => {
  it("throws StartupError when session does not exist", async () => {
    await withTempHome(async () => {
      await expect(sessionApprove("sess_missing", "allow")).rejects.toThrow(StartupError);
    });
  });

  it("throws StartupError when session is not waiting_approval", async () => {
    await withTempHome(async () => {
      await createSession({ id: "sess_idle2", agent: "mock", runtime: "local", cwd: "/tmp" });
      await expect(sessionApprove("sess_idle2", "allow")).rejects.toThrow(/not waiting for approval/);
    });
  });

  it("calls adapter.respondToApproval with 'allow'", async () => {
    await withTempHome(async () => {
      await createSession({ id: "sess_pend", agent: "mock", runtime: "local", cwd: "/tmp" });
      await updateSession("sess_pend", (r) => {
        r.status = "waiting_approval";
        r.pid = 777;
        r.pgid = 777;
        r.lastRunId = "run_abc";
      });

      await sessionApprove("sess_pend", "allow");

      expect(baseAdapter.respondToApproval).toHaveBeenCalledWith(
        { runId: "run_abc", sessionId: "sess_pend", pid: 777, pgid: 777 },
        "allow",
      );
    });
  });

  it("resets session status on deny", async () => {
    await withTempHome(async () => {
      await createSession({ id: "sess_deny", agent: "mock", runtime: "local", cwd: "/tmp" });
      await updateSession("sess_deny", (r) => {
        r.status = "waiting_approval";
        r.pid = 888;
        r.pgid = 888;
      });

      await sessionApprove("sess_deny", "deny");

      const rec = await readSession("sess_deny");
      expect(rec?.status).toBe("idle");
      expect(rec?.pid).toBeUndefined();
    });
  });
});
