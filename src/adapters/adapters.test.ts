import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cursorAdapter } from "./cursor.js";
import { claudeAdapter } from "./claude.js";
import * as streamProcess from "./streamProcess.js";
import type { SessionHandle, SendOptions } from "../types.js";

const session: SessionHandle = {
  id: "sess_argv",
  agent: "cursor",
  runtime: "local",
  cwd: "/workspace/repo",
  externalSessionId: "resume-id-123",
};

const sendOpts: SendOptions = {
  prompt: "-malicious-flag",
  approve: "all",
  settings: "project",
  model: "composer-2.5",
  sandbox: true,
  interactive: false,
};

describe("adapter argv building", () => {
  let runSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    runSpy = vi.spyOn(streamProcess, "runStreamJsonAgent").mockReturnValue(
      (async function* () {
        yield { type: "done", outcome: "finished", exitCode: 0 };
      })(),
    );
  });

  afterEach(() => {
    runSpy.mockRestore();
  });

  it("cursor places -- before the prompt to prevent flag injection", () => {
    cursorAdapter.send(session, sendOpts);
    const call = runSpy.mock.calls[0]![0];
    const args = call.args;
    const dashIdx = args.indexOf("--");
    expect(dashIdx).toBeGreaterThan(-1);
    expect(args[dashIdx + 1]).toBe("-malicious-flag");
    expect(args).toContain("--trust");
    expect(args).toContain("--workspace");
    expect(args).toContain("/workspace/repo");
    expect(args).toContain("--resume");
    expect(args).toContain("resume-id-123");
    expect(args).toContain("--force");
    expect(args).toContain("--sandbox");
    expect(args).toContain("enabled");
  });

  it("claude places -- before the prompt and maps approve all to bypassPermissions", () => {
    claudeAdapter.send({ ...session, agent: "claude" }, sendOpts);
    const args = runSpy.mock.calls[0]![0].args;
    const dashIdx = args.indexOf("--");
    expect(dashIdx).toBeGreaterThan(-1);
    expect(args[dashIdx + 1]).toBe("-malicious-flag");
    expect(args).toContain("--verbose");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("bypassPermissions");
  });
});

describe("adapter cancel", () => {
  it("cursor signals the process group when pgid is set", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    cursorAdapter.cancel({ runId: "r1", sessionId: "s1", pid: 10, pgid: 10 });
    expect(kill).toHaveBeenCalledWith(-10, "SIGTERM");
    kill.mockRestore();
  });

  it("cursor falls back to pid when pgid is missing", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    cursorAdapter.cancel({ runId: "r1", sessionId: "s1", pid: 10 });
    expect(kill).toHaveBeenCalledWith(10, "SIGTERM");
    kill.mockRestore();
  });

  it("claude throws when neither pid nor pgid is available", async () => {
    await expect(claudeAdapter.cancel({ runId: "r1", sessionId: "s1" })).rejects.toThrow(/no active process/);
  });
});
