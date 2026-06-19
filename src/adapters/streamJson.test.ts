import { describe, it, expect } from "vitest";
import { StreamJsonParser } from "./streamJson.js";
import type { AgentEvent } from "../types.js";

/** Replays NDJSON lines through the parser and returns flattened events. */
function run(lines: string[]): { events: AgentEvent[]; parser: StreamJsonParser } {
  const parser = new StreamJsonParser();
  const events: AgentEvent[] = [];
  for (const line of lines) {
    events.push(...parser.parse(JSON.parse(line)));
  }
  return { events, parser };
}

// Captured from a real `agent -p --output-format stream-json` run.
const REAL_SAMPLE = [
  '{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp/x","session_id":"abc-123","model":"Opus 4.8","permissionMode":"default"}',
  '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly the word: pong"}]},"session_id":"abc-123"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"pong"}]},"session_id":"abc-123"}',
  '{"type":"result","subtype":"success","duration_ms":5826,"is_error":false,"result":"pong","session_id":"abc-123","usage":{"inputTokens":2,"outputTokens":4}}',
];

describe("StreamJsonParser", () => {
  it("captures the external session id from system/init", () => {
    const { parser } = run(REAL_SAMPLE);
    expect(parser.externalSessionId).toBe("abc-123");
  });

  it("emits assistant_text deltas and a terminal done", () => {
    const { events, parser } = run(REAL_SAMPLE);
    expect(events.find((e) => e.type === "assistant_text")).toEqual({
      type: "assistant_text",
      text: "pong",
    });
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", outcome: "finished", exitCode: 0, result: "pong" });
    expect(parser.doneEmitted).toBe(true);
  });

  it("does not emit user text as assistant_text", () => {
    const { events } = run(REAL_SAMPLE);
    const assistantTexts = events.filter((e) => e.type === "assistant_text");
    expect(assistantTexts).toHaveLength(1);
  });

  it("emits a usage event from result", () => {
    const { events } = run(REAL_SAMPLE);
    expect(events.find((e) => e.type === "usage")).toEqual({
      type: "usage",
      inputTokens: 2,
      outputTokens: 4,
    });
  });

  it("maps tool_use blocks to tool_call and tool_result blocks to tool_result", () => {
    const { events } = run([
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"shell","input":{"cmd":"ls"}}]},"session_id":"s"}',
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":false,"content":"file.txt"}]},"session_id":"s"}',
    ]);
    expect(events).toContainEqual({ type: "tool_call", id: "t1", name: "shell", input: { cmd: "ls" } });
    expect(events).toContainEqual({ type: "tool_result", id: "t1", name: "", ok: true, output: "file.txt" });
  });

  it("marks is_error results as a failed done", () => {
    const { events } = run([
      '{"type":"result","subtype":"error","is_error":true,"result":"boom","session_id":"s"}',
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", outcome: "error", exitCode: 2 });
  });

  it("ignores malformed / unknown lines", () => {
    const parser = new StreamJsonParser();
    expect(parser.parse({ type: "unknown_thing" })).toEqual([]);
    expect(parser.parse(null)).toEqual([]);
    expect(parser.parse(42)).toEqual([]);
  });
});
