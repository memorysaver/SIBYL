# SIBYL-008 — Tasks

- [x] `bun install` at the repo root (installs the `@earendil-works/*` pins from
      the lockfile in a fresh worktree).
- [x] Read the merged building blocks in the worktree: `src/engine/{session,seam,
    state-machine,originate}.ts`, `src/tools/git.ts`, `src/memory/decisions.ts`,
      `src/renderer/{app,modal-form,progress}.ts`; the `SIBYL-008` story +
      `data_flows`/`protocol_sequences` in `product-context.yaml`;
      `docs/research/pi-integration.md`; the e2e policy + the
      `00-walking-skeleton.md` journey seed. Confirmed the real scripted
      `AgentSessionEvent` shapes from `test/originate.test.ts` and the
      `appendDecision`/`recallDecisions` wiring from `test/decisions.test.ts`.
- [x] `main.ts` — `runOriginate(options)`: compose `createEngine(createOriginateCore
    ({connect, commitMessage}))`, subscribe the headless renderer (`createApp` +
      `createModalForm`), drive the full loop THROUGH the modal-form controller
      (`setValue`/`submitForm`/`chooseDecision`; only `start_run` dispatched
      directly), persist the commit decision on `run_completed` via `appendDecision`,
      and return the EngineEvent stream + completion/failure + recalled decisions.
- [x] `main.ts` — decision-memory wiring: boot a capture session over an explicit
      `SessionManager` to get the real `ExtensionAPI`, append the `originate`/`Commit`
      `DecisionEntry`, recall via `recallDecisions`.
- [x] `main.ts` — `createScriptedConnect`: a scripted `OriginateSession` emitting the
      REAL Pi event shapes (tool round-trip + `text_delta` stream + `agent_end`)
      producing the values-seeded imagine README; the non-interactive default.
- [x] `main.ts` — `mountOriginate(engine)`: compose `ModalFormView` beside
      `AgentRunView` under ONE shared pi-tui `TUI` (TTY-only live path; provided +
      type-checked, not exercised headlessly).
- [x] `main.ts` — `runCli(argv, io)` + `cli.ts` bin + `bin`/`start` in
      `package.json`: `--version`, `originate` (seeded values + `--yes` auto-commit,
      live `phase:`/`progress:` stream, `.sibyl/decisions.json` mirror), `decisions
    ls`. Default `GIT_*` identity set so the commit step works in temp dirs/CI.
- [x] Integration test `test/originate-e2e.test.ts`: fresh `mktemp` cwd → full
      composed pipeline with a capturing scripted agent → - Criterion 1: `README.md` committed (`git ls-files`/`git log`/`git show
      --stat HEAD`). - Criterion 2: `recallDecisions` ≥ 1 (`originate`/`Commit`). - Criterion 3: exact ordered EngineEvent/progress stream; values + choice came
      through the modal-form controller (prompt seeded, model selection `Commit`),
      no raw commands.
- [x] CLI dogfood tests: `--version` → `sibyl 0.0.0`; `originate` end-to-end (exit 0,
      progress + `decisions: 1`, committed README) then `decisions ls` reads it back;
      missing seed value → exit 2.
- [x] Fill `skills/e2e-test/journeys/00-walking-skeleton.md` with the REAL invocation
      (`bun apps/harness/src/cli.ts …`); ran both scenarios green via bash.
- [x] Green: `tsc --noEmit` (check-types) and `vitest run` (70 tests) pass.
- [x] Lint/format clean on the changed files (oxlint + oxfmt), no unrelated repo
      files reformatted.
- [ ] Rebase on `origin/main`, re-run tests, open PR with evidence, merge if all 3
      criteria objectively green.
