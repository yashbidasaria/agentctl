#!/usr/bin/env node
/** Sleeps then prints one NDJSON line (for timeout tests). */
const delayMs = Number.parseInt(process.argv[2] ?? "5000", 10);
const line =
  process.argv[3] ??
  '{"type":"result","subtype":"success","is_error":false,"result":"late","session_id":"slow"}';

setTimeout(() => {
  console.log(line);
}, delayMs);
