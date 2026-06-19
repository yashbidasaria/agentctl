#!/usr/bin/env node
/** Prints each argv line as NDJSON stdout (for subprocess tests). */
for (const line of process.argv.slice(2)) {
  console.log(line);
}
