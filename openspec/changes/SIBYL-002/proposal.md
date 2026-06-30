# SIBYL-002 — Engine seam: EngineEvent/EngineCommand + run/phase state machine

## What

Define the load-bearing engine↔renderer seam (ADR-001): a host-agnostic engine
that exposes `dispatch(EngineCommand)` / `subscribe(EngineEvent)`, runs an
enforced run/phase state machine, and streams structured events — with **no
`pi-tui` import and no `ctx.ui` reference** anywhere in the engine.

- `apps/harness/src/engine/state-machine.ts` — the `Phase` type
  (`idle → form → running → decision → done/failed`), the transition table, and
  a `PhaseMachine` that enforces ordering (`InvalidTransitionError` on illegal
  transitions, without mutating state). Pure: no Pi, no I/O.
- `apps/harness/src/engine/seam.ts` — the `EngineEvent` / `EngineCommand`
  discriminated unions (the contract SIBYL-003/006/007 consume), runtime
  conformance guards (`isEngineEvent` / `isEngineCommand`), a tiny typed event
  emitter, the `EngineSeam` surface, and `createEngine(core)` which wires the
  command surface to the phase machine + event stream. The Pi-agent originate
  run is injected as an `EngineRunCore` (the SIBYL-003 plug-in point); this layer
  is exercised by a fake core.

No new runtime dependencies (pure TS + a small typed emitter).

## Why

This is the load-bearing engine↔renderer seam (ADR-001). The structured event
stream + injected core make the renderer swappable and the future web surface a
new consumer; orchestration never references presentation.

## Non-goals

- No real Pi-agent-driven originate run (that is SIBYL-003 — it implements
  `EngineRunCore` over the Pi `AgentSession` and maps `tool_execution_*` /
  `message_update` to `progress` events).
- No renderer / pi-tui UI (SIBYL-006+ consumes this seam).
- No narrow git tool (SIBYL-004) or decision-memory persistence (SIBYL-005).

## Acceptance criteria

1. `EngineEvent` and `EngineCommand` types are defined and exported
   (discriminated unions on `type`).
2. A renderer-agnostic smoke test drives a full originate run via the seam
   (events only) with **no `ctx.ui` import in the engine**.
3. Run/phase transitions (`idle → form → running → decision → done/failed`) are
   enforced.

## Verification

- Unit — `test/state-machine.test.ts`: the transition table + `PhaseMachine`
  (full lifecycle, illegal transitions rejected without mutation, abort→failed).
- Integration — `test/seam-smoke.test.ts`: headless full originate run via
  EngineEvents, abort mid-run, core-failure classification, seam-level
  enforcement of out-of-phase commands.
- Contract — `test/seam-contract.test.ts`: EngineEvent/EngineCommand schema
  conformance (every variant accepted, malformed/cross-kind rejected) + a source
  scan asserting no `ctx.ui` / `pi-tui` in the engine code.

## Pi API drift vs research doc

None. This layer touches no Pi API: the seam and state machine are pure TS, and
the Pi-backed run is deferred to SIBYL-003 behind the `EngineRunCore` injection
seam. `@earendil-works/pi-coding-agent@0.80.2` remains the only engine dep
(unchanged, via `session.ts`).
