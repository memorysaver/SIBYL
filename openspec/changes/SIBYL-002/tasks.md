# SIBYL-002 — Tasks

- [x] Read the existing `apps/harness` source (`session.ts`, `extension.ts`,
      configs, tests) + `product-context.yaml` (engine module, `originate-run`
      sequence, interfaces, ADR-001) and the Pi research doc; match conventions.
- [x] `state-machine.ts` — `Phase` union, `PHASES`/`TERMINAL_PHASES`,
      `Transition` union, the transition table, `nextPhase`/`canTransition`/
      `isTerminal`, and `PhaseMachine` (enforces `idle→form→running→decision→
    done/failed`; `InvalidTransitionError` without state mutation). Pure.
- [x] `seam.ts` — `EngineEvent` / `EngineCommand` discriminated unions + shared
      payload sub-types + `RunFailureClass`; `ENGINE_EVENT_TYPES` /
      `ENGINE_COMMAND_TYPES` / `PROGRESS_KINDS` / `RUN_FAILURE_CLASSES`;
      `isEngineEvent` / `isEngineCommand` guards.
- [x] `seam.ts` — tiny typed `EngineEventEmitter`, `EngineSeam` surface, the
      injected `EngineRunCore` (SIBYL-003 plug-in point), `RunFailure`, and
      `createEngine(core)` wiring commands → phase machine → event stream.
- [x] Keep the engine free of `pi-tui` / `ctx.ui`; no new runtime deps.
- [x] Unit test: state-machine transition table + `PhaseMachine`.
- [x] Integration test: headless full originate run via the seam (events only),
      abort, core-failure classification, out-of-phase enforcement.
- [x] Contract test: EngineEvent/EngineCommand schema conformance + a source
      scan proving no `ctx.ui` / `pi-tui` in the engine.
- [x] Green: `tsc --noEmit` (check-types) and `vitest run` (23 tests) pass.
- [x] Lint/format clean on the changed files (oxlint + oxfmt), no unrelated
      repo files reformatted.
- [x] Rebase on `origin/main`, re-run tests, open PR with evidence, merge.
