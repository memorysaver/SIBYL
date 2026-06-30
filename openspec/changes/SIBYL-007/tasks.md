# SIBYL-007 — Tasks

- [x] Read the seam (`src/engine/seam.ts` — `form_requested` / `decision_requested`
      EngineEvents + `submit_form` / `submit_decision` EngineCommands, the only
      thing the renderer consumes), the SIBYL-006 shell (`renderer/app.ts` +
      `renderer/progress.ts` — the pure-model ↔ pi-tui-view split + `createApp` /
      `mount` patterns), the renderer tests, `docs/research/pi-integration.md`
      (pi-tui section), the `SIBYL-007` story + ADR-003 in `product-context.yaml`,
      and the `vision` / `project` slice of the Object Map (`vision:create`
      screen; `vision` core attrs `title` + long-form `content`).
- [x] `bun install` at the repo root (installs the `@earendil-works/*` pins from
      the lockfile in a fresh worktree).
- [x] Verify the REAL pi-tui `Input` / `Editor` / `SelectList` APIs against the
      installed `@earendil-works/pi-tui@0.80.2` `.d.ts` (not memory): `Input`
      (`getValue`/`setValue`/`onSubmit`), `Editor` (`new Editor(tui, theme)`,
      `getText`/`setText`/`onChange`/`onSubmit`), `SelectList` (`new
    SelectList(items, maxVisible, theme)`, `onSelect`/`setSelectedIndex`).
      Confirmed construction + render are side-effect-free over a non-started
      terminal (so the view renders headlessly).
- [x] `modal-form.ts` — `FormFieldKind` + `classifyField` (short → Input,
      `vision` → Editor), the pure `ModalFormModel` (discrete field buffers →
      `values()`; decision selection by index/value → `selectedChoice`), the
      `ModalForm` controller (`handle` form/decision events → `dispatch`
      `submit_form` / `submit_decision`), and `ModalFormView` (pi-tui `Container`:
      labeled `Input`/`Editor` per field + a `SelectList` decision selector,
      built from the model, rendered headlessly).
- [x] `createModalForm(engine)` — headless controller wiring (subscribe +
      dispatch, no TTY), analogous to `createApp`. `mountModalForm(engine)` — the
      TTY-only `ProcessTerminal` + `TUI` mount, kept separate + untested.
- [x] Keep the modal form free of the Pi SDK/agent — imports only
      `@earendil-works/pi-tui` and the local seam types.
- [x] Unit test: `classifyField`, `ModalFormModel` field buffers → values,
      decision selection by index/value (+ guards).
- [x] Criterion 1 test: `form_requested` → entered values → exact `submit_form`
      payload; the view renders one editable widget per field (Input/Input/Editor).
- [x] Criterion 2 test: `decision_requested` → choose "Commit" → `submit_decision
    { choice: "Commit" }`; index-select → `submitDecision`; the view renders the
      prompt + every option in a `SelectList`.
- [x] Criterion 3 test: structural view-shape (3 discrete keyed field widgets + 1
      `SelectList`, no transcript — non-form events never add fields) + a
      `modal-form.ts` source scan (no Pi SDK). The shared
      `test/renderer-no-pi-sdk.test.ts` now also covers `modal-form.ts`.
- [x] Seam end-to-end test: `createModalForm` driven off a live fake-core engine
      (`start_run` → form → `submit_form` → decision → `submit_decision` →
      `run_completed`).
- [x] Green: `tsc --noEmit` (check-types) and `vitest run` (65 tests) pass.
- [x] Lint/format clean on the changed files (oxlint + oxfmt), no unrelated repo
      files reformatted.
- [ ] Rebase on `origin/main`, re-run tests, open PR with evidence, merge.
