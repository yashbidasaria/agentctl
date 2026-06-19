import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { collect, withTempHome } from "../test/helpers.js";
import { createSession, readSession, updateSession } from "../sessionStore.js";
import * as sessionStore from "../sessionStore.js";
import { runStreamJsonAgent } from "./streamProcess.js";
import * as subprocess from "../util/subprocess.js";

const RESULT_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
  session_id: "ext-sess-1",
});

function mockProc(overrides: Partial<ReturnType<typeof subprocess.spawnLineStream>> = {}) {
  const kill = vi.fn();
  const state = { timedOut: false, exited: true, exitCode: 0 };
  return {
    pid: 4242,
    pgid: 4242,
    lines: (async function* () {
      yield RESULT_LINE;
    })(),
    state,
    kill,
    ...overrides,
  };
}

describe("runStreamJsonAgent", () => {
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spawnSpy = vi.spyOn(subprocess, "spawnLineStream");
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  it("writes pid/pgid before yielding meta", async () => {
    await withTempHome(async () => {
      let metaYielded = false;
      spawnSpy.mockImplementation(() => {
        const proc = mockProc({
          lines: (async function* () {
            yield RESULT_LINE;
          })(),
        });
        return proc;
      });

      await createSession({ id: "sess_meta", agent: "cursor", runtime: "local", cwd: "/tmp" });

      const events: unknown[] = [];
      for await (const event of runStreamJsonAgent({
        agent: "cursor",
        binary: "agent",
        args: ["-p", "hi"],
        session: { id: "sess_meta", agent: "cursor", runtime: "local", cwd: "/tmp" },
        send: { prompt: "hi", approve: "none", settings: "project", interactive: false },
      })) {
        if (event.type === "meta" && !metaYielded) {
          metaYielded = true;
          const during = await readSession("sess_meta");
          expect(during?.pid).toBe(4242);
          expect(during?.pgid).toBe(4242);
          expect(during?.status).toBe("running");
        }
        events.push(event);
      }

      expect(metaYielded).toBe(true);
      expect(events[0]).toMatchObject({ type: "meta", agent: "cursor" });
    });
  });

  it("passes timeoutSec=0 as 0ms timeout to spawnLineStream", () => {
    spawnSpy.mockReturnValue(mockProc());
    void collect(
      runStreamJsonAgent({
        agent: "cursor",
        binary: "agent",
        args: [],
        session: { id: "sess_nope", agent: "cursor", runtime: "local", cwd: "/tmp" },
        send: { prompt: "x", approve: "none", settings: "project", timeoutSec: 0, interactive: false },
      }),
    );
    expect(spawnSpy).toHaveBeenCalledWith("agent", [], expect.objectContaining({ timeoutMs: 0 }));
  });

  it("kills the process when pre-yield session update fails", async () => {
    const kill = vi.fn();
    spawnSpy.mockReturnValue(mockProc({ kill }));

    const updateSpy = vi.spyOn(sessionStore, "updateSession");
    updateSpy.mockRejectedValueOnce(new Error("ENOSPC: no space left on device"));

    await expect(
      collect(
        runStreamJsonAgent({
          agent: "cursor",
          binary: "agent",
          args: [],
          session: { id: "sess_fail", agent: "cursor", runtime: "local", cwd: "/tmp" },
          send: { prompt: "x", approve: "none", settings: "project", interactive: false },
        }),
      ),
    ).rejects.toThrow("ENOSPC");

    expect(kill).toHaveBeenCalledWith("SIGKILL");
    updateSpy.mockRestore();
  });

  it("sets session status to timeout when the process times out", async () => {
    await withTempHome(async () => {
      spawnSpy.mockReturnValue(
        mockProc({
          state: { timedOut: true, exited: true, exitCode: null },
          lines: (async function* () {
            // no result line — process killed by timeout
          })(),
        }),
      );

      await createSession({ id: "sess_timeout", agent: "cursor", runtime: "local", cwd: "/tmp" });

      const events = await collect(
        runStreamJsonAgent({
          agent: "cursor",
          binary: "agent",
          args: [],
          session: { id: "sess_timeout", agent: "cursor", runtime: "local", cwd: "/tmp" },
          send: { prompt: "x", approve: "none", settings: "project", timeoutSec: 1, interactive: false },
        }),
      );

      const done = events.find((e) => e.type === "done");
      expect(done).toMatchObject({ outcome: "timeout", exitCode: 4 });

      const rec = await readSession("sess_timeout");
      expect(rec?.status).toBe("timeout");
    });
  });

  it("swallows only Session not found on pre-yield update (ad-hoc run)", async () => {
    spawnSpy.mockReturnValue(mockProc());

    const events = await collect(
      runStreamJsonAgent({
        agent: "cursor",
        binary: "agent",
        args: [],
        session: { id: "sess_adhoc", agent: "cursor", runtime: "local", cwd: "/tmp" },
        send: { prompt: "x", approve: "none", settings: "project", interactive: false },
      }),
    );

    expect(events.at(-1)).toMatchObject({ type: "done", outcome: "finished" });
  });
});
