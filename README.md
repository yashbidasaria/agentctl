# agentctl

[![CI](https://github.com/yashbidasaria/agentctl/actions/workflows/ci.yml/badge.svg)](https://github.com/yashbidasaria/agentctl/actions/workflows/ci.yml)

**The open-source control plane for coding agent CLIs.**

Run Cursor, Claude Code, and Codex with one command surface and one event
stream. `agentctl` doesn't replace your agents — it makes them scriptable,
swappable, and resumable.

> Status: Phase 2. The **Cursor and Claude Code adapters work end to end** —
> `run`, `session create/send/cancel`, and multi-turn resume drive the real
> `agent` and `claude` CLIs via their (shared) `stream-json` output.

## Why agentctl?

- **One CLI, many agents** — same flags for `run`, `session`, `resume`
- **Stable stream-json events** — build CI and tooling without per-vendor parsers
- **Cursor-first OSS** — first-class Cursor SDK + CLI adapter
- **No server, no YAML** — a single self-contained binary for local dev and CI
- **MIT licensed** — community adapters welcome

## Install (dev)

```bash
npm install
npm run dev -- agents doctor
```

Build (Node/tsc):

```bash
npm run build
node dist/index.js agents list
```

Build a single self-contained binary (requires [bun](https://bun.sh)):

```bash
npm run build:binary   # -> dist/agentctl
./dist/agentctl agents list
```

## Quick start

```bash
agentctl agents doctor
agentctl run --agent cursor -p "fix failing tests"
agentctl run --agent claude  -p "review PR diff"
```

## Commands

| Command | Status | Description |
|---------|--------|-------------|
| `agents list` | working | List adapters and capabilities |
| `agents doctor` | working | Check binaries + auth |
| `config get` / `config set <k> <v>` | working | View/update config |
| `run` | working (cursor) | One-shot synchronous prompt |
| `session create` / `send` / `cancel` | working (cursor) | Durable multi-turn sessions with resume |
| `session follow` / `resume` / `approve` | stubbed | Planned |

Example:

```bash
agentctl run --agent cursor -p "explain this repo" --format stream-json
agentctl run --agent claude -p "explain this repo" --format stream-json
SID=$(agentctl session create --agent claude)
agentctl session send "$SID" "add a test for foo()"
agentctl session send "$SID" "now run it"   # resumes context
```

## Global flags

`--cwd`, `--model` (agent-specific), `--runtime local|cloud` (default `local`),
`--approve all|none` (default `none`), `--sandbox enabled|disabled`,
`--settings inline|project|all` (default `project`), `--timeout <sec>`,
`--format text|json|stream-json`.

## Architecture

```
CLI (commander)
  └─ Adapter registry
       ├─ cursor   (@cursor/sdk, subprocess fallback)
       └─ claude   (claude CLI subprocess)
  └─ Session store (~/.agentctl, lock-guarded)
  └─ Normalized AgentEvent stream  ← the stable contract
```

The normalized `AgentEvent` stream is the product. See
[docs/ADAPTER.md](docs/ADAPTER.md) for the schema, versioning policy, and how to
contribute an adapter.

## License

MIT — see [LICENSE](LICENSE).
