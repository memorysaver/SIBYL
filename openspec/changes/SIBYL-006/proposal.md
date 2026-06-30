# SIBYL-006 — TUI shell + UI-mode state machine (form-mode) + progress render

## What

The face of the engine↔renderer seam (ADR-001): a custom, non-chat
`@earendil-works/pi-tui` renderer that subscribes to `EngineEvent`s, runs a
UI-mode state machine mirroring the engine `Phase`, and streams live progress.
It consumes ONLY the seam — never the Pi SDK.

- `apps/harness/src/renderer/progress.ts` — the live progress widget. A pure,
  append-only `ProgressLog` (no pi-tui, no TTY) modelling `agent_run.progress_log`
  (tool activity + streaming assistant text), and `ProgressWidget`, a pi-tui
  `Component` whose `render(width)` is pure (renders the log into `Box`/`Text`).
- `apps/harness/src/renderer/app.ts` — the shell. `AgentRunView` (extends the
  pi-tui `Container`) renders the `agent_run:detail` screen from the Object Map
  slice — `phase` (card_field) + derived `status`, plus the streamed
  `progress_log` — and runs the UI-mode state machine: `handle(EngineEvent)`
  advances the mode on `phase_changed` and appends to the progress log on
  `progress`. `deriveStatus(phase)` maps `Phase → agent_run.status`. `createApp`
  wires the view to the seam's `subscribe` (headless, no TTY); `mount` is the
  ONLY part that touches a real terminal (`ProcessTerminal` raw TTY) and is kept
  separate so the render logic is unit-testable without a live terminal.

New dependency: `@earendil-works/pi-tui@0.80.2` on `apps/harness` (pinned, kept
out of the shared Bun catalog like the other Pi pins). Verified it installs and
imports + renders headlessly under both Node 22+ and Bun before building on it.

## Why

This is the face of the seam (ADR-001): it proves a custom, non-chat renderer
that consumes the engine purely through structured `EngineEvent`s. The UI-mode
state machine and progress widget are the v0 (form-mode) shell that the modal
FORM component (SIBYL-007) and the originate run (SIBYL-003/008) render into.

## Non-goals

- No modal FORM component / field collection (that is SIBYL-007 — this story is
  the shell + progress widget + UI-mode state machine that reacts to events).
- No real Pi-agent run (SIBYL-003 implements `EngineRunCore` over the Pi
  `AgentSession`); the renderer only ever sees `EngineEvent`s.
- No CLI entry point wiring `mount()` to a live engine (a later story); `mount`
  is provided and type-checked but not exercised headlessly.

## Acceptance criteria

1. The shell renders and reacts to `phase_changed` + `progress` events — the
   UI-mode state machine mirrors the engine `Phase`, and live progress (tool
   activity + assistant text) streams into the rendered `agent_run:detail` view.
2. No Pi SDK import exists in the renderer (it consumes only `EngineEvent`s) —
   proven by a source scan: the renderer may import `@earendil-works/pi-tui`
   (UI lib) but NOT `@earendil-works/pi-coding-agent` / `pi-agent` (SDK/agent).

## Verification

- Unit — `test/renderer-shell.test.ts`: the UI-mode state machine (mode
  transitions on every `phase_changed`, and ONLY on `phase_changed`),
  `deriveStatus` over every phase, progress appended on `progress`, payload
  capture, and the pure `ProgressLog` model.
- Integration — `test/renderer-shell.test.ts`: a scripted `EngineEvent` stream
  fed to `AgentRunView` asserts the rendered `agent_run:detail` output reflects
  `phase` + streamed progress + completion/failure (pi-tui render, headless, no
  TTY); plus an end-to-end drive off a live fake-core engine via the seam's
  `subscribe` (consumes ONLY `EngineEvent`s).
- Contract/source-scan — `test/renderer-no-pi-sdk.test.ts`: scans
  `src/renderer/*.ts` (comments stripped) and asserts the ONLY `@earendil-works/*`
  import is `pi-tui` — no `pi-coding-agent` / `pi-agent` / `pi-ai` (criterion 2).

## pi-tui install + runtime caveat

`@earendil-works/pi-tui@0.80.2` installs cleanly (already a transitive dep of
`pi-coding-agent`; promoted to a direct pin). Empirically verified: importing
the package and rendering `Container`/`Box`/`Text` to `string[]` works
**headlessly under both Node and Bun** — no TTY needed for the pure components.
The raw-TTY / native-addon surface the research doc warns about lives only in
`ProcessTerminal` (raw stdin) and the `TUI` mount; that is isolated to `mount()`
and excluded from tests. The view logic and progress widget are therefore fully
unit-testable without a live terminal.

## Pi API drift vs research doc

None. The pi-tui exports used (`TUI`, `Container`, `Component`, `Box`, `Text`,
`ProcessTerminal`) match the research doc's component list. The renderer touches
no Pi SDK/agent API — only `pi-tui` components and the local seam types.
