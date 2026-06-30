# SIBYL-006 — Tasks

- [x] Read the seam (`src/engine/seam.ts` — `EngineEvent`/`subscribe`, the only
      thing the renderer consumes), `state-machine.ts`, the harness configs +
      tests for conventions, `docs/research/pi-integration.md` (pi-tui section),
      the `SIBYL-006` story in `product-context.yaml`, and the `agent_run` object
      in `product/maps/guided-aep-journey-tui/object-map.yaml`.
- [x] Add `@earendil-works/pi-tui@0.80.2` to `apps/harness/package.json` (exact
      pin, kept out of the shared Bun catalog); `bun install`.
- [x] Verify pi-tui installs AND imports + renders headlessly under the runtime
      BEFORE building: imported the package and rendered `Container`/`Box`/`Text`
      to `string[]` with no TTY under both Node and Bun. (Raw-TTY surface is
      confined to `ProcessTerminal` / the `TUI` mount.)
- [x] `progress.ts` — `ProgressEntry`, `formatProgressLine`, a pure append-only
      `ProgressLog` (no pi-tui/TTY), and `ProgressWidget` (pi-tui `Component`
      rendering the log into `Box`/`Text`; pure `render(width)`).
- [x] `app.ts` — `UiMode` (= `Phase`), `RunStatus`, `deriveStatus`, and
      `AgentRunView` (extends pi-tui `Container`): renders `agent_run:detail`
      (`phase` card_field + derived `status` + streamed `progress_log`) and runs
      the UI-mode state machine in `handle(EngineEvent)` (advance on
      `phase_changed`, append on `progress`, capture form/decision/completion/
      failure). `createApp(engine)` subscribes the view (headless); `mount(engine)`
      is the TTY-only `ProcessTerminal` + `TUI` mount, kept separate + untested.
- [x] Keep the renderer free of the Pi SDK/agent — imports only
      `@earendil-works/pi-tui` and the local seam types.
- [x] Unit test: UI-mode state machine (transitions on every `phase_changed`,
      only on `phase_changed`), `deriveStatus`, progress append, `ProgressLog`.
- [x] Integration test: scripted `EngineEvent` stream → rendered `agent_run:detail`
      output reflects phase + progress (headless pi-tui render); plus an
      end-to-end drive off a live fake-core engine via `subscribe`.
- [x] Source-scan test: `src/renderer/*.ts` imports only `pi-tui` among
      `@earendil-works/*` — proves criterion 2 (no Pi SDK in the renderer).
- [x] Green: `tsc --noEmit` (check-types) and `vitest run` (49 tests) pass.
- [x] Lint/format clean on the changed files (oxlint + oxfmt), no unrelated
      repo files reformatted.
- [ ] Rebase on `origin/main`, re-run tests, open PR with evidence, merge.
