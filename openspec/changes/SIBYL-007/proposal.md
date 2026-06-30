# SIBYL-007 — Modal form component: render form schema, collect values, decision gate

## What

The product's SIGNATURE form-mode surface (ADR-003): a structured MODAL FORM —
explicitly NOT a chat transcript — that renders a `form_requested` schema as
discrete editable fields, collects their values into a `submit_form` command,
then renders a `decision_requested` as a selectable list and emits the chosen
`submit_decision`. This is the `vision:create` screen of the Object Map: the
form CONSTRUCTS the Vision/README (`vision.title` + long-form `vision.content`)
from the originate fields (`product` / `problem` / `vision`).

All new code lives in `apps/harness/src/renderer/modal-form.ts`, mirroring the
SIBYL-006 shell's pure-model ↔ pi-tui-view split:

- `ModalFormModel` — the PURE form-state model: a fixed set of discrete,
  independently-buffered fields (field buffer → `values()`) plus the decision
  selection (index/value → `selectedChoice`). No `@earendil-works/pi-tui`, no
  TTY, no Pi SDK. The headless, unit-testable core.
- `ModalForm` — the controller binding the model to the engine↔renderer seam: it
  `handle`s `form_requested` / `decision_requested` EngineEvents and `dispatch`es
  `submit_form` / `submit_decision` EngineCommands back through the seam (every
  other event is ignored — the shell's `AgentRunView` owns phase/progress).
- `ModalFormView` (extends pi-tui `Container`) — the realization: one `Input`
  per short field (`product` / `problem`) and a multi-line `Editor` for the
  long-form `vision` README body, plus a `SelectList` decision selector. Built
  fresh from the model on `refresh()` and rendered headlessly.
- `createModalForm(engine)` — headless controller wiring (subscribe + dispatch,
  no TTY), analogous to SIBYL-006's `createApp`. `mountModalForm(engine)` is the
  TTY-only `ProcessTerminal` + `TUI` mount, kept separate and untested.

No new dependency: `@earendil-works/pi-tui@0.80.2` is already a direct pin from
SIBYL-006. The view embeds a multi-line `Editor` (which reads `tui.terminal.rows`),
so `ModalFormView` takes a `TUI`; construction + `render` are side-effect-free
over a non-started terminal, so the view renders headlessly in tests.

## Why

The product's signature UX is a structured modal form for README construction,
NOT a chat transcript (ADR-003: "a form is more observable/deterministic than
chat and is the product identity"). This is the form-mode surface SIBYL-008 wires
into the full originate journey (collect README fields → run → commit decision).

## Non-goals

- No real Pi-agent run or README/git side effects (SIBYL-003 / SIBYL-004 /
  SIBYL-008); the modal form only renders EngineEvents and dispatches commands.
- No CLI entry point composing `mountModalForm` beside the shell under one live
  TTY (SIBYL-008); `mountModalForm` is provided + type-checked but not exercised
  headlessly (it touches a real `ProcessTerminal`).
- No styling/theme polish or focus-traversal refinement of the live view (the L0.5
  ux-flow calibration + SIBYL-008); v0 uses identity themes and a simple
  next-field-on-submit focus advance.

## Acceptance criteria

1. `form_requested` renders editable fields; `submit_form` sends the collected
   `values`. Feeding `{ fields: [product, problem, vision] }`, entering values,
   and submitting dispatches `{ type: "submit_form", values: { product, problem,
vision } }`. The view renders one `Input`/`Input`/`Editor` editable widget per
   field.
2. `decision_requested` renders the options; `submit_decision` sends the chosen
   `choice`. Feeding `{ prompt: "Commit this README?", options: [Commit, Revise,
Cancel] }`, choosing "Commit" dispatches `{ type: "submit_decision", choice:
"Commit" }`; the view renders the prompt + every option in a `SelectList`.
3. It is a MODAL FORM, not a chat transcript (structural + source-scan): the view
   is N discrete editable field widgets keyed by name + a single decision
   selector (not one growing message list — non-form events never add fields),
   and `modal-form.ts` imports NO Pi SDK (`pi-coding-agent` / `pi-agent` /
   `pi-ai`), only `pi-tui` — matching SIBYL-006's scan.

## Verification

- Unit — `test/modal-form.test.ts`: `classifyField` (short → Input, `vision` →
  Editor); `ModalFormModel` discrete field buffers → `values()`; decision
  selection by index and by value (+ range/unknown-field guards).
- Criterion 1 — `test/modal-form.test.ts`: a captured-dispatch controller fed
  `form_requested` collects entered values into the exact `submit_form` payload;
  the headless view renders one editable widget per field (Input/Input/Editor)
  with field labels.
- Criterion 2 — `test/modal-form.test.ts`: choosing "Commit" dispatches
  `submit_decision { choice: "Commit" }`; index-select → `submitDecision`
  dispatches the selected option; the headless view renders the prompt + every
  option in a `SelectList`.
- Criterion 3 — `test/modal-form.test.ts`: a structural view-shape test (3
  discrete keyed field widgets + 1 `SelectList`, no transcript — progress/phase
  events never add fields) and a `modal-form.ts` source scan (no Pi SDK). The
  shared `test/renderer-no-pi-sdk.test.ts` scan also now covers `modal-form.ts`.
- Seam end-to-end — `test/modal-form.test.ts`: `createModalForm` driven off a
  live fake-core engine (`start_run` → `form_requested` → `submit_form` →
  `decision_requested` → `submit_decision` → `run_completed`) proves the
  controller works through the REAL seam, not just a capturing dispatch.
- Green: `tsc --noEmit` (check-types) and `vitest run` (65 tests) pass;
  oxlint + oxfmt clean on the changed files.

## pi-tui API used + form-state API exposed (for SIBYL-008)

- pi-tui components: `Container` (view base), `Input` (short fields), `Editor`
  (long-form `vision`/README body — needs a `TUI`), `SelectList` (decision),
  `Text` (labels), `TUI` + `ProcessTerminal` (mount only).
- Form-state/decision API for SIBYL-008 to wire the full originate journey:
  `createModalForm(engine) → { form, unsubscribe }`; `form.model.fields`,
  `form.setValue(name, value)`, `form.submitForm()`; `form.model.decision`,
  `form.select(index)` / `form.chooseDecision(choice)` / `form.submitDecision()`.
  `mountModalForm(engine)` composes the live `ModalFormView` for the TTY.

## Pi / pi-tui API drift vs research doc

None. The pi-tui exports used (`Input`, `Editor`, `SelectList`, `Box`, `Text`,
`Container`, `TUI`, `ProcessTerminal`) match the research doc's component list.
Verified against the installed `@earendil-works/pi-tui@0.80.2` type declarations:
`Input` (`getValue`/`setValue`/`onSubmit`), `Editor` (`new Editor(tui, theme,
options)`, `getText`/`setText`/`onChange`/`onSubmit`), `SelectList` (`new
SelectList(items, maxVisible, theme)`, `onSelect`/`onSelectionChange`/
`setSelectedIndex`/`getSelectedItem`). The story's note mentioned the
`ctx.ui.custom` SDK route as an ALTERNATIVE; this story takes the seam-driven
pi-tui path (ADR-001/ADR-003) so the renderer touches no Pi SDK. The view embeds
a multi-line `Editor` and therefore carries a `TUI` (unlike SIBYL-006's
TUI-free `AgentRunView`) — a justified, documented deviation; both build and
render headlessly over a non-started terminal.
