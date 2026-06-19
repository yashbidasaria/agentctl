import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { collect } from "../test/helpers.js";
import { spawnLineStream } from "./subprocess.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../test/fixtures");
const ECHO = path.join(FIXTURES, "ndjson-echo.mjs");
const SLOW = path.join(FIXTURES, "slow-echo.mjs");

describe("spawnLineStream", () => {
  it("streams stdout lines from a child process", async () => {
    const line1 = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "a" }] } });
    const line2 = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "a" });
    const proc = spawnLineStream(process.execPath, [ECHO, line1, line2]);
    const lines = await collect(proc.lines);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "assistant" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: "result" });
  });

  it("sets timedOut and kills the process when timeoutMs elapses", async () => {
    const proc = spawnLineStream(process.execPath, [SLOW, "2000"], { timeoutMs: 80 });
    const lines = await collect(proc.lines);
    expect(lines).toHaveLength(0);
    expect(proc.state.timedOut).toBe(true);
  });

  it("treats timeoutMs=0 as an immediate timeout", async () => {
    const proc = spawnLineStream(process.execPath, [SLOW, "500"], { timeoutMs: 0 });
    const lines = await collect(proc.lines);
    expect(lines).toHaveLength(0);
    expect(proc.state.timedOut).toBe(true);
  });
});
