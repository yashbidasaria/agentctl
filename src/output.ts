import type { AgentEvent, OutputFormat } from "./types.js";

/**
 * Renders the normalized event stream to the chosen output format.
 *  - text:        human-readable; prints assistant text and a final summary
 *  - json:        a single final object emitted on `done`
 *  - stream-json: one normalized event per line (NDJSON)
 */
export class OutputWriter {
  private finalText = "";

  constructor(private readonly format: OutputFormat) {}

  write(event: AgentEvent): void {
    switch (this.format) {
      case "stream-json":
        process.stdout.write(`${JSON.stringify(event)}\n`);
        return;
      case "json":
        if (event.type === "assistant_text") this.finalText += event.text;
        if (event.type === "done") {
          process.stdout.write(
            `${JSON.stringify({ ...event, result: event.result ?? this.finalText })}\n`,
          );
        }
        return;
      case "result":
        // Collect deltas; print only the final answer text on done.
        if (event.type === "assistant_text") this.finalText += event.text;
        if (event.type === "error") process.stderr.write(`\n[error] ${event.message}\n`);
        if (event.type === "done") {
          const text = event.result ?? this.finalText;
          if (text) process.stdout.write(`${text}\n`);
        }
        return;
      case "text":
      default:
        this.renderText(event);
    }
  }

  private renderText(event: AgentEvent): void {
    switch (event.type) {
      case "assistant_text":
        process.stdout.write(event.text);
        break;
      case "tool_call":
        process.stderr.write(`\n[tool] ${event.name}\n`);
        break;
      case "status":
        if (event.state === "waiting_approval") process.stderr.write("\n[awaiting approval]\n");
        break;
      case "error":
        process.stderr.write(`\n[error] ${event.message}\n`);
        break;
      case "done":
        process.stdout.write("\n");
        break;
      default:
        break;
    }
  }
}
