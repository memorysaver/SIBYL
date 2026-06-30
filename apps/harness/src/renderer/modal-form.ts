/**
 * Modal form surface (SIBYL-007, ADR-003).
 *
 * The product's SIGNATURE UX: a structured MODAL FORM — explicitly NOT a chat
 * transcript — that renders a `form_requested` schema as discrete editable
 * fields, collects their values into a `submit_form` command, then renders a
 * `decision_requested` as a selectable list and emits the chosen
 * `submit_decision`. This is the `vision:create` screen of the Object Map: the
 * form CONSTRUCTS the Vision/README (`vision.title` + long-form `vision.content`)
 * from the originate fields (`product` / `problem` / `vision`).
 *
 * It is the FORM-MODE face of the engine↔renderer seam (ADR-001) and mirrors the
 * SIBYL-006 shell's split exactly:
 *   - {@link ModalFormModel} — the PURE form-state model (field buffer → values;
 *     selection → choice). No `@earendil-works/pi-tui`, no TTY, no Pi SDK. This
 *     is the unit-testable core.
 *   - {@link ModalForm} — the controller that binds the model to the seam: it
 *     `handle`s the engine's `form_requested` / `decision_requested` events and
 *     `dispatch`es `submit_form` / `submit_decision` back through the seam.
 *   - {@link ModalFormView} — the `@earendil-works/pi-tui` realization: one
 *     `Input` (short fields) or `Editor` (long-form `vision`/README body) per
 *     field, plus a `SelectList` decision selector.
 *
 * Like SIBYL-006 it consumes ONLY the seam (`EngineEvent` / `EngineCommand`) and
 * the pi-tui UI library; it does NOT import the Pi SDK / agent
 * (`@earendil-works/pi-coding-agent` / `pi-agent` / `pi-ai`) — proven by the
 * renderer source scan. The pure model + controller need no TTY; only
 * {@link ModalFormView} (which embeds a multi-line `Editor`, so it needs a `TUI`)
 * and {@link mountModalForm} touch pi-tui, keeping the form-state logic headless.
 */

import {
  Container,
  Editor,
  type EditorTheme,
  Input,
  ProcessTerminal,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  Text,
  TUI,
} from "@earendil-works/pi-tui";

import type {
  EngineCommand,
  EngineEvent,
  EngineSeam,
  FormSchema,
  Unsubscribe,
} from "../engine/seam";

// ---------------------------------------------------------------------------
// Pure form-state model (no pi-tui, no TTY, no Pi SDK).
// ---------------------------------------------------------------------------

/** How a field is edited: single-line {@link Input} or multi-line {@link Editor}. */
export type FormFieldKind = "input" | "editor";

/**
 * Field names that render as a long-form multi-line {@link Editor} (the README
 * body, Object Map `vision.content`). Everything else is a single-line `Input`
 * (short, title-like values such as `product` / `problem`).
 */
export const LONG_FORM_FIELDS: readonly string[] = ["vision"];

/** Classify a `form_requested` field name into its editor kind. */
export function classifyField(name: string): FormFieldKind {
  return LONG_FORM_FIELDS.includes(name) ? "editor" : "input";
}

/** An immutable snapshot of one editable field (name + edit kind + buffer). */
export interface FormFieldState {
  readonly name: string;
  readonly kind: FormFieldKind;
  readonly value: string;
}

/** An immutable snapshot of the pending decision gate. */
export interface DecisionState {
  readonly prompt: string;
  readonly options: readonly string[];
  readonly selectedIndex: number;
}

interface MutableField {
  readonly name: string;
  readonly kind: FormFieldKind;
  value: string;
}

interface MutableDecision {
  readonly prompt: string;
  readonly options: readonly string[];
  selectedIndex: number;
}

/**
 * The PURE form-state model: a fixed set of discrete, independently-buffered
 * fields (NOT an append-only transcript) plus the decision selection. Drives the
 * `submit_form` / `submit_decision` payloads; fully headless and unit-testable.
 */
export class ModalFormModel {
  #fields: MutableField[] = [];
  #decision: MutableDecision | undefined;

  /** Build the discrete editable fields from a `form_requested` schema. */
  loadForm(schema: FormSchema): void {
    this.#fields = schema.fields.map((name) => ({
      name,
      kind: classifyField(name),
      value: "",
    }));
  }

  /** True once a form schema has been loaded. */
  hasForm(): boolean {
    return this.#fields.length > 0;
  }

  /** The discrete fields, in schema order (immutable snapshots). */
  get fields(): readonly FormFieldState[] {
    return this.#fields.map((field) => ({
      name: field.name,
      kind: field.kind,
      value: field.value,
    }));
  }

  /** Set the buffer for the named field. Throws on an unknown field. */
  setValue(name: string, value: string): void {
    const field = this.#fields.find((candidate) => candidate.name === name);
    if (!field) {
      throw new Error(`Unknown form field: ${name}`);
    }
    field.value = value;
  }

  /** The collected `{ field: value }` payload for `submit_form`. */
  values(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const field of this.#fields) {
      out[field.name] = field.value;
    }
    return out;
  }

  /** Build the decision gate from a `decision_requested` event. */
  loadDecision(prompt: string, options: readonly string[]): void {
    this.#decision = { prompt, options: [...options], selectedIndex: 0 };
  }

  /** The pending decision (immutable snapshot), or `undefined`. */
  get decision(): DecisionState | undefined {
    if (!this.#decision) {
      return undefined;
    }
    return {
      prompt: this.#decision.prompt,
      options: [...this.#decision.options],
      selectedIndex: this.#decision.selectedIndex,
    };
  }

  /** Move the decision selection to `index`. Throws if out of range. */
  select(index: number): void {
    if (!this.#decision) {
      throw new Error("No decision to select");
    }
    if (index < 0 || index >= this.#decision.options.length) {
      throw new RangeError(`Decision index out of range: ${index}`);
    }
    this.#decision.selectedIndex = index;
  }

  /** Select the decision option by value. Throws on an unknown option. */
  selectChoice(choice: string): void {
    if (!this.#decision) {
      throw new Error("No decision to select");
    }
    const index = this.#decision.options.indexOf(choice);
    if (index < 0) {
      throw new Error(`Unknown decision option: ${choice}`);
    }
    this.#decision.selectedIndex = index;
  }

  /** The currently-selected option value, or `undefined` if no decision. */
  get selectedChoice(): string | undefined {
    if (!this.#decision) {
      return undefined;
    }
    return this.#decision.options[this.#decision.selectedIndex];
  }
}

// ---------------------------------------------------------------------------
// Controller: binds the pure model to the engine↔renderer seam.
// ---------------------------------------------------------------------------

/** A sink for the commands the modal form emits (the seam's `dispatch`). */
export type FormDispatch = (command: EngineCommand) => void | Promise<void>;

/**
 * The modal-form controller: reacts to the engine's `form_requested` /
 * `decision_requested` EngineEvents (every other event is ignored — the shell's
 * {@link import("./app").AgentRunView} owns phase/progress) and emits
 * `submit_form` / `submit_decision` EngineCommands back through `dispatch`.
 * Holds the pure {@link ModalFormModel}; needs no TTY, so tests drive it with a
 * capturing dispatch.
 */
export class ModalForm {
  /** The pure form-state model (field buffers + decision selection). */
  readonly model = new ModalFormModel();
  readonly #dispatch: FormDispatch;

  constructor(dispatch: FormDispatch) {
    this.#dispatch = dispatch;
  }

  /** Apply one EngineEvent; only form/decision requests mutate the form. */
  handle(event: EngineEvent): void {
    switch (event.type) {
      case "form_requested":
        this.model.loadForm(event.schema);
        break;
      case "decision_requested":
        this.model.loadDecision(event.prompt, event.options);
        break;
      default:
        break;
    }
  }

  /** Buffer a value for a field (delegates to the model). */
  setValue(name: string, value: string): void {
    this.model.setValue(name, value);
  }

  /** Emit `submit_form` with the collected field values. */
  submitForm(): void | Promise<void> {
    return this.#dispatch({ type: "submit_form", values: this.model.values() });
  }

  /** Move the decision selection (delegates to the model). */
  select(index: number): void {
    this.model.select(index);
  }

  /** Select `choice` and emit `submit_decision` for it in one step. */
  chooseDecision(choice: string): void | Promise<void> {
    this.model.selectChoice(choice);
    return this.#dispatch({ type: "submit_decision", choice });
  }

  /** Emit `submit_decision` for the currently-selected option. */
  submitDecision(): void | Promise<void> {
    const choice = this.model.selectedChoice;
    if (choice === undefined) {
      throw new Error("No decision selected");
    }
    return this.#dispatch({ type: "submit_decision", choice });
  }
}

// ---------------------------------------------------------------------------
// pi-tui view: discrete editable fields + a decision selector.
// ---------------------------------------------------------------------------

/** `vision:create` screen title (Object Map screen for `vision`). */
const TITLE = "SIBYL · vision:create";

/** `vision:create` empty-state (Object Map `screens.vision.empty_state`). */
const EMPTY_STATE = "Imagine the project — start the README";

/** Identity-styled SelectList theme (styling is the live theme's job, later). */
const SELECT_THEME: SelectListTheme = {
  selectedPrefix: (text) => text,
  selectedText: (text) => text,
  description: (text) => text,
  scrollInfo: (text) => text,
  noMatch: (text) => text,
};

/** Identity-styled Editor theme. */
const EDITOR_THEME: EditorTheme = {
  borderColor: (text) => text,
  selectList: SELECT_THEME,
};

/** A built editable field: its name/kind plus the live pi-tui widget. */
export interface FieldWidget {
  readonly name: string;
  readonly kind: FormFieldKind;
  readonly widget: Input | Editor;
}

/**
 * The `vision:create` modal-form view: a pi-tui {@link Container} that renders
 * the controller's discrete fields as labeled `Input` / `Editor` rows and the
 * decision gate as a `SelectList`. Built fresh from the model on {@link refresh}
 * (the model is the source of truth), wiring each widget's submit/select back to
 * the controller. `render(width)` is pure given its `TUI` (the `Editor` reads
 * `tui.terminal.rows`), so it renders headlessly over a non-started terminal.
 */
export class ModalFormView extends Container {
  readonly #form: ModalForm;
  readonly #tui: TUI;
  #fieldWidgets: FieldWidget[] = [];
  #decisionWidget: SelectList | undefined;

  constructor(form: ModalForm, tui: TUI) {
    super();
    this.#form = form;
    this.#tui = tui;
    this.refresh();
  }

  /** The built editable field widgets (one discrete entry per schema field). */
  get fieldWidgets(): readonly FieldWidget[] {
    return this.#fieldWidgets;
  }

  /** The decision selector, or `undefined` before a decision is requested. */
  get decisionWidget(): SelectList | undefined {
    return this.#decisionWidget;
  }

  /**
   * Rebuild the rendered surface from the current model state: a header, one
   * labeled editable field per schema field, then (if present) the decision
   * prompt + selector. Widgets are rebuilt fresh and seeded from the model so
   * the displayed buffer always reflects collected values.
   */
  refresh(): void {
    this.clear();
    this.#fieldWidgets = [];
    this.#decisionWidget = undefined;

    this.addChild(new Text(TITLE));

    const fields = this.#form.model.fields;
    if (fields.length === 0) {
      this.addChild(new Text(EMPTY_STATE));
    }
    fields.forEach((field, index) => {
      const fieldWidget = this.#buildField(field, index, fields.length);
      this.#fieldWidgets.push(fieldWidget);
      this.addChild(new Text(`${field.name}:`));
      this.addChild(fieldWidget.widget);
    });

    const decision = this.#form.model.decision;
    if (decision) {
      this.addChild(new Text(decision.prompt));
      this.#decisionWidget = this.#buildDecision(decision);
      this.addChild(this.#decisionWidget);
    }
  }

  /** Build one labeled field widget, seeded from the model and wired to submit. */
  #buildField(field: FormFieldState, index: number, total: number): FieldWidget {
    const isLast = index === total - 1;
    if (field.kind === "editor") {
      const editor = new Editor(this.#tui, EDITOR_THEME);
      editor.setText(field.value);
      editor.onChange = (text) => {
        this.#form.setValue(field.name, text);
      };
      editor.onSubmit = (text) => {
        this.#form.setValue(field.name, text);
        this.#onFieldSubmit(index, isLast);
      };
      return { name: field.name, kind: field.kind, widget: editor };
    }
    const input = new Input();
    input.setValue(field.value);
    input.onSubmit = (value) => {
      this.#form.setValue(field.name, value);
      this.#onFieldSubmit(index, isLast);
    };
    return { name: field.name, kind: field.kind, widget: input };
  }

  /** Build the decision selector, seeded to the model's selection + wired. */
  #buildDecision(decision: DecisionState): SelectList {
    const items: SelectItem[] = decision.options.map((option) => ({
      value: option,
      label: option,
    }));
    const list = new SelectList(items, items.length, SELECT_THEME);
    list.setSelectedIndex(decision.selectedIndex);
    list.onSelectionChange = (item) => {
      this.#form.model.selectChoice(item.value);
    };
    list.onSelect = (item) => {
      void this.#form.chooseDecision(item.value);
    };
    return list;
  }

  /** Read the current widget value into the model (single-line vs multi-line). */
  #fieldValue(fieldWidget: FieldWidget): string {
    return fieldWidget.kind === "editor"
      ? (fieldWidget.widget as Editor).getText()
      : (fieldWidget.widget as Input).getValue();
  }

  /** Pull every widget's current value into the model. */
  collect(): void {
    for (const fieldWidget of this.#fieldWidgets) {
      this.#form.setValue(fieldWidget.name, this.#fieldValue(fieldWidget));
    }
  }

  /** Advance focus to the next field, or collect + submit after the last one. */
  #onFieldSubmit(index: number, isLast: boolean): void {
    if (isLast) {
      this.collect();
      void this.#form.submitForm();
      return;
    }
    const next = this.#fieldWidgets[index + 1];
    if (next) {
      this.#tui.setFocus(next.widget);
    }
  }
}

// ---------------------------------------------------------------------------
// Wiring: headless controller (no TTY) and a live TTY mount.
// ---------------------------------------------------------------------------

/** A headless modal form: a {@link ModalForm} subscribed to an engine (no TTY). */
export interface RunningModalForm {
  readonly form: ModalForm;
  readonly unsubscribe: Unsubscribe;
}

/**
 * Wire a {@link ModalForm} controller to the engine's event stream and have it
 * dispatch back through the same seam. This is the pure, headless half (no
 * terminal, no `Editor`/`TUI`) — the surface tests drive with a fake-core engine
 * and a scripted EngineEvent stream. The live {@link ModalFormView} is composed
 * on top at {@link mountModalForm} time (SIBYL-008 wires it beside the shell's
 * AgentRunView under one TTY).
 */
export function createModalForm(engine: EngineSeam): RunningModalForm {
  const form = new ModalForm((command) => engine.dispatch(command));
  const unsubscribe = engine.subscribe((event) => {
    form.handle(event);
  });
  return { form, unsubscribe };
}

/** A mounted modal form: the headless form plus its live pi-tui view + TUI. */
export interface MountedModalForm extends RunningModalForm {
  readonly view: ModalFormView;
  readonly tui: TUI;
  /** Unsubscribe from the engine and stop the TUI render loop. */
  stop(): void;
}

/**
 * Mount the modal form into a live terminal. The ONLY part that touches a real
 * TTY (`ProcessTerminal` raw mode), kept separate from {@link createModalForm} /
 * {@link ModalFormModel} so the form-state logic stays headless and is NOT
 * exercised by the unit tests. Requires `process.stdout.isTTY`; SIBYL-008's CLI
 * entry point composes this with the shell.
 */
export function mountModalForm(engine: EngineSeam): MountedModalForm {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const form = new ModalForm((command) => engine.dispatch(command));
  const view = new ModalFormView(form, tui);
  tui.addChild(view);

  const unsubscribe = engine.subscribe((event) => {
    form.handle(event);
    view.refresh();
    const first = view.fieldWidgets[0]?.widget ?? view.decisionWidget;
    if (first) {
      tui.setFocus(first);
    }
    tui.requestRender();
  });

  tui.start();
  tui.requestRender();

  return {
    form,
    view,
    tui,
    unsubscribe,
    stop(): void {
      unsubscribe();
      tui.stop();
    },
  };
}
