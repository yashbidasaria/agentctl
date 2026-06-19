import type { AgentEvent } from "../types.js";

/**
 * Parser for the Claude-Code-compatible `stream-json` NDJSON format used by
 * both the Cursor CLI (`agent --output-format stream-json`) and Claude Code
 * (`claude --output-format stream-json`).
 *
 * Observed line shapes:
 *   { type: "system", subtype: "init", session_id, model, cwd, ... }
 *   { type: "user", message: { role, content: [...] }, session_id }
 *   { type: "assistant", message: { role, content: [textBlock|toolUse], usage? } }
 *   { type: "result", subtype: "success"|..., is_error, result, usage?, session_id }
 *
 * The parser is stateless except for capturing the backend's `session_id`
 * (exposed as `externalSessionId`) and tracking whether a terminal `done` was
 * emitted. It does NOT emit the leading `meta` event — adapters do that up
 * front so `meta` is guaranteed first even before the subprocess prints.
 */
export class StreamJsonParser {
  externalSessionId?: string;
  doneEmitted = false;

  parse(obj: unknown): AgentEvent[] {
    if (!isRecord(obj) || typeof obj.type !== "string") return [];
    switch (obj.type) {
      case "system":
        return this.parseSystem(obj);
      case "assistant":
        return this.parseMessage(obj, "assistant");
      case "user":
        return this.parseMessage(obj, "user");
      case "result":
        return this.parseResult(obj);
      default:
        return [];
    }
  }

  private parseSystem(obj: Record<string, unknown>): AgentEvent[] {
    if (typeof obj.session_id === "string") this.externalSessionId = obj.session_id;
    return [];
  }

  private parseMessage(obj: Record<string, unknown>, role: "assistant" | "user"): AgentEvent[] {
    if (typeof obj.session_id === "string") this.externalSessionId = obj.session_id;
    const message = isRecord(obj.message) ? obj.message : undefined;
    const content = message && Array.isArray(message.content) ? message.content : [];
    const events: AgentEvent[] = [];

    for (const block of content) {
      if (!isRecord(block) || typeof block.type !== "string") continue;
      switch (block.type) {
        case "text":
          if (role === "assistant" && typeof block.text === "string") {
            events.push({ type: "assistant_text", text: block.text });
          }
          break;
        case "thinking":
        case "reasoning":
          if (typeof block.text === "string") events.push({ type: "reasoning", text: block.text });
          break;
        case "tool_use":
          events.push({
            type: "tool_call",
            id: asString(block.id) ?? "",
            name: asString(block.name) ?? "unknown",
            input: block.input ?? null,
          });
          break;
        case "tool_result":
          events.push({
            type: "tool_result",
            id: asString(block.tool_use_id) ?? "",
            name: asString(block.name) ?? "",
            ok: block.is_error !== true,
            output: block.content ?? null,
          });
          break;
        default:
          break;
      }
    }

    if (role === "assistant" && message && isRecord(message.usage)) {
      events.push(usageEvent(message.usage));
    }
    return events;
  }

  private parseResult(obj: Record<string, unknown>): AgentEvent[] {
    if (typeof obj.session_id === "string") this.externalSessionId = obj.session_id;
    const events: AgentEvent[] = [];
    if (isRecord(obj.usage)) events.push(usageEvent(obj.usage));

    const isError = obj.is_error === true;
    this.doneEmitted = true;
    events.push({
      type: "done",
      outcome: isError ? "error" : "finished",
      exitCode: isError ? 2 : 0,
      result: asString(obj.result),
    });
    return events;
  }
}

function usageEvent(usage: Record<string, unknown>): AgentEvent {
  return {
    type: "usage",
    inputTokens: asNumber(usage.inputTokens ?? usage.input_tokens),
    outputTokens: asNumber(usage.outputTokens ?? usage.output_tokens),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
