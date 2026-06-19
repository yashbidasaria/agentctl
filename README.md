# agentctl

**The open-source control plane for coding agent CLIs.**

Run Cursor, Claude Code, and Codex with one command surface and one event
stream. `agentctl` doesn't replace your agents — it makes them scriptable,
swappable, and resumable.

> Status: early scaffold. `agents list`, `agents doctor`, and `config` work
> today. `run` and `session` lifecycle commands are stubbed while the Cursor
> (Phase 1) and Claude Code (Phase 2) adapters are implemented.

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
| `run` | stubbed | One-shot synchronous prompt |
| `session create/send/follow/resume/approve/cancel` | stubbed | Durable multi-turn sessions |

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
