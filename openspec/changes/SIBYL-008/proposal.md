# SIBYL-008 — End-to-end Originate journey (integration)

## What

The Layer-0 walking skeleton — the capstone that wires the already-merged
building blocks (engine, narrow git tool, decision memory, shell + modal-form
renderer) into ONE runnable pipeline. From an EMPTY directory, SIBYL drives the
modal-form imagine pass, writes `README.md`, `git init` + commits it, and persists
≥1 decision-memory entry — with NO raw Pi/git commands typed.

All new code lives in the composition root `apps/harness/src/main.ts` plus a thin
runnable bin `apps/harness/src/cli.ts` (and a `bin`/`start` entry in
`apps/harness/package.json`). No new runtime dependency.

- `runOriginate(options)` — the headless composed pipeline. It builds
  `createEngine(createOriginateCore({ connect, commitMessage }))` (SIBYL-002/003),
  subscribes the headless renderer (`createApp` shell view + `createModalForm`
  controller, SIBYL-006/007), drives the run THROUGH the modal-form controller
  (`form.setValue` / `form.submitForm` / `form.chooseDecision` — the only directly
  dispatched command is the lifecycle `start_run`), and on `run_completed` persists
  the human's commit decision via `appendDecision` (SIBYL-005) into a `SessionManager`
  recallable through `recallDecisions`. Returns the full EngineEvent stream,
  completion/failure, and the recalled decisions.
- `createScriptedConnect(options)` — the non-interactive `connect` port: a scripted
  `OriginateSession` that emits the REAL Pi `AgentSessionEvent` shapes (tool
  round-trip + `text_delta` stream + `agent_end`) producing the imagine README, so
  the journey/test run deterministically with NO live model.
- `mountOriginate(engine)` — the LIVE path: composes the `ModalFormView` beside the
  shell's `AgentRunView` as children of ONE shared pi-tui `TUI` (the only code that
  touches a real `ProcessTerminal` raw TTY; provided + type-checked, not exercised
  headlessly).
- `runCli(argv, io)` — the `sibyl` bin dispatcher: `--version`, `originate
--product/--problem/--vision [--yes] [--cwd] [--message]`, and `decisions ls
[--cwd]`. `originate` streams live `phase:` / `progress:` lines and mirrors the
  recalled decision log to `<cwd>/.sibyl/decisions.json` so `decisions ls` reads it
  back across invocations.

## Why

This story IS the Layer-0 layer-gate journey (Tier-2): "the skeleton walks." It is
the first proof that renderer ↔ engine ↔ tools ↔ memory compose into the guided
originate flow end-to-end, before any module goes deep.

## Non-goals

- No live model. The walking skeleton drives a scripted `AgentSession` through the
  originate `connect` port; swapping in `defaultConnect` (a real Pi agent) is a
  later story. The honest proof of criteria 1–2 is the scripted-agent integration
  test + the bash journey.
- No interactive TTY session driving. `mountOriginate` composes both views under one
  `TUI` for the future interactive path, but the CLI runs non-interactively
  (deterministic) and the live mount is not exercised in CI (it needs a real TTY).
- No styling/theme polish or focus-traversal refinement (the L0.5 ux-flow
  calibration); v0 reuses the renderer's identity themes.
- The decision persistence is wired in `main.ts` (on `run_completed`), leaving the
  SIBYL-003 originate core untouched — `originate.complete` keeps returning the
  `decisions` count and stays decoupled from the memory backend.

## Acceptance criteria

1. From an empty temp dir, a full run produces a COMMITTED `README.md` in a new
   local git repo (`git log` shows the commit; `git show --stat HEAD` lists
   `README.md`).
2. ≥1 decision-memory entry is persisted (the Commit decision → `appendDecision`,
   recallable via `recallDecisions`).
3. Live progress renders throughout (`tool_execution` + `message_update` →
   `progress` events flow to the shell view / CLI stdout); the user types NO raw
   Pi/git commands — form values + the commit choice arrive through the modal-form
   controller.

## Verification

- Integration — `test/originate-e2e.test.ts`: in a fresh `mktemp` cwd, `runOriginate`
  with a capturing scripted `OriginateSession` →
  - Criterion 1: `completion.artifacts === ["README.md"]`; `git ls-files` ===
    `README.md`; `git log` contains the commit; `git show --stat HEAD` lists
    `README.md`.
  - Criterion 2: `result.decisions.length ≥ 1` (`{ phase: "originate", decision:
"Commit" }`); `recallDecisions(sessionManager)` round-trips from the store.
  - Criterion 3: the exact ordered EngineEvent stream (`phase_changed` →
    `form_requested` → … → `progress`×N → `decision_requested` → `run_completed`);
    the shell view's progress log filled; the seeded values reached the agent prompt
    and the model selection is `"Commit"` — proving form input flowed through the
    controller (the values were only ever set via `form.setValue`), not raw commands.
- CLI dogfood — `test/originate-e2e.test.ts`: `runCli(["--version"])` prints
  `sibyl 0.0.0`; `runCli(["originate", …, "--yes", "--cwd", DIR])` exits 0, streams
  `phase:`/`progress:`/`artifacts:`/`decisions: 1`, commits `README.md`; then
  `runCli(["decisions", "ls", "--cwd", DIR])` reads `decisions: 1` / `[originate]
Commit` back; a missing seed value exits 2.
- Default scripted connect — `runOriginate` with no injected session still walks the
  skeleton (values-seeded README committed, ≥1 decision).
- Journey — `skills/e2e-test/journeys/00-walking-skeleton.md` filled with the real
  invocation (`bun apps/harness/src/cli.ts …`) and run green via bash end-to-end.
- Green: `tsc --noEmit` (check-types) and `vitest run` (70 tests) pass; oxlint +
  oxfmt clean on the changed files; no unrelated files reformatted.

## How a decision gets persisted (the exact wiring)

The originate core (SIBYL-003) is decoupled from the memory backend — `complete`
runs `git init/add/commit` via the narrow git tool and returns a `decisions` count,
but does not call `appendDecision`. `main.ts` owns the memory wiring:
`runOriginate` boots a minimal Pi session that captures the real `ExtensionAPI`
(the `bootWithCapturedPi` pattern from `test/decisions.test.ts`) over an explicit
`SessionManager`; when the controller's `chooseDecision("Commit")` drives the run to
`run_completed`, `main.ts` calls `appendDecision(pi, { id, phase: "originate",
decision: "Commit", at })`, which persists a `custom` `sibyl-decision` session entry
(excluded from the LLM context). `recallDecisions(sessionManager)` reads it back.

## Pi / pi-tui API drift vs research doc

None. The composition uses only the merged public surfaces: `createEngine` /
`createOriginateCore` (`connect` port), `createApp` / `createModalForm` /
`AgentRunView` / `ModalFormView`, `appendDecision` / `recallDecisions`, `bootSession`,
`runGit`. Pi SDK surfaces used in `main.ts` (`SessionManager.inMemory`, the captured
`ExtensionAPI.appendEntry` via `appendDecision`, the scripted `AgentSessionEvent`
shapes) match `docs/research/pi-integration.md` and `@earendil-works/*@0.80.2`. The
scripted event shapes are mirrored verbatim from the already-merged
`test/originate.test.ts`. The renderer-no-pi-sdk source scan is unaffected (`main.ts`
is the composition root, not a renderer file).
