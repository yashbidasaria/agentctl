# Writing an agentctl adapter

An adapter teaches `agentctl` how to drive one agent backend (a CLI binary or
SDK) and translate its output into the normalized `AgentEvent` stream. The event
stream — not the binary — is the project's stable contract.

## The interface

Implement `AgentAdapter` from [`src/types.ts`](../src/types.ts):

```ts
interface AgentAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  doctor(): Promise<DoctorReport>;
  createSession(opts: SessionOptions): Promise<SessionHandle>;
  resumeSession(externalId: string, opts: SessionOptions): Promise<SessionHandle>;
  send(session: SessionHandle, prompt: SendOptions): AsyncIterable<AgentEvent>;
  respondToApproval(run: RunHandle, decision: "allow" | "deny"): Promise<void>;
  cancel(run: RunHandle): Promise<void>;
  listModels?(): Promise<ModelInfo[]>;
}
```

Register it in [`src/adapters/registry.ts`](../src/adapters/registry.ts).

## Event contract rules

1. Emit a `meta` event **first**, carrying the current `schemaVersion`.
2. Emit exactly **one terminal `done`** event with an `outcome`.
3. `assistant_text` is an **incremental delta** — consumers concatenate it.
4. `status` is for **non-terminal** states only (`running`, `waiting_approval`).
5. Only emit event types your backend actually exposes; declare them in
   `capabilities.emits`. Consumers must tolerate missing optional types.

## Schema versioning

`SCHEMA_VERSION` is semver:

- **Additive** changes (new optional fields / event types) → **minor** bump.
- **Breaking** changes (removed/renamed fields, changed semantics) → **major**
  bump, announced here with a deprecation window.

## Lifecycle expectations

- **Subprocess adapters** must spawn children in their own process group and
  tear them down on `SIGINT`/`SIGTERM` so no agent processes are orphaned.
- Persist the active run's `pid`/`pgid` so a separate `agentctl` process can
  `cancel` or `approve` it.
- **Approvals:** on `waiting_approval`, interactive TTYs prompt inline; piped/CI
  runs follow the `--approve` policy; detached sessions use `session approve`.

## Testing

- Record real backend output as NDJSON fixtures and unit-test your parser with
  record-replay (no live agents in CI, no API cost).
- Add schema tests: `meta` first, exactly one terminal `done`.

## Capability matrix

`agents list` advertises each adapter's `capabilities`. Be honest — surfacing
real limits (no resume, no cloud, no sandbox) beats faking parity.
