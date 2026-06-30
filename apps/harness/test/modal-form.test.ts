import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Editor, Input, SelectList, type Terminal, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import {
  createEngine,
  type EngineCommand,
  type EngineEvent,
  type EngineRunCore,
  type EngineSeam,
} from "../src/engine/seam";
import {
  classifyField,
  createModalForm,
  ModalForm,
  ModalFormModel,
  ModalFormView,
} from "../src/renderer/modal-form";

/**
 * SIBYL-007: the modal form renders a `form_requested` schema as discrete
 * editable fields → `submit_form`, and a `decision_requested` as a selectable
 * list → `submit_decision`. It is a MODAL FORM, not a chat transcript (ADR-003),
 * and imports NO Pi SDK (mirrors SIBYL-006's scan).
 *
 * The pure model + controller are tested headlessly (no TTY). The pi-tui
 * `ModalFormView` embeds a multi-line `Editor`, which reads `tui.terminal.rows`,
 * so the structural/render tests build a real `TUI` over a HEADLESS fake
 * terminal — no raw mode, no `tui.start()`.
 */

/** The originate form fields the engine actually requests at runtime. */
const FORM_FIELDS = ["product", "problem", "vision"] as const;

/** The originate decision the engine actually requests at runtime. */
const DECISION = {
  prompt: "Commit this README?",
  options: ["Commit", "Revise", "Cancel"] as const,
};

/** A headless terminal: satisfies the pi-tui `Terminal` interface, all no-ops. */
function headlessTerminal(): Terminal {
  return {
    start: () => {},
    stop: () => {},
    drainInput: () => Promise.resolve(),
    write: () => {},
    get columns() {
      return 80;
    },
    get rows() {
      return 24;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
  };
}

/** Build a view over a headless TUI for the given controller. */
function headlessView(form: ModalForm): ModalFormView {
  return new ModalFormView(form, new TUI(headlessTerminal()));
}

/** Capture the commands a controller dispatches. */
function capturingForm(): { form: ModalForm; dispatched: EngineCommand[] } {
  const dispatched: EngineCommand[] = [];
  const form = new ModalForm((command) => {
    dispatched.push(command);
  });
  return { form, dispatched };
}

/** A fake originate core walking the phases (no Pi / model call). */
const originateCore: EngineRunCore = {
  startForm: () => ({ fields: [...FORM_FIELDS] }),
  runToDecision: async (ctx) => {
    ctx.emitProgress({ kind: "message_update", detail: "Drafting README.md" });
    return { prompt: DECISION.prompt, options: [...DECISION.options] };
  },
  complete: () => ({ artifacts: ["README.md"], decisions: 1 }),
};

/** Resolve when the engine emits an event of `type`. */
function waitForType(engine: EngineSeam, type: EngineEvent["type"]): Promise<EngineEvent> {
  return new Promise((resolve) => {
    const unsub = engine.subscribe((event) => {
      if (event.type === type) {
        unsub();
        resolve(event);
      }
    });
  });
}

describe("ModalFormModel — pure form-state (field buffer → values)", () => {
  it("classifies short fields as Input and long-form vision as Editor", () => {
    expect(classifyField("product")).toBe("input");
    expect(classifyField("problem")).toBe("input");
    expect(classifyField("vision")).toBe("editor");
  });

  it("builds one discrete, independently-buffered field per schema field", () => {
    const model = new ModalFormModel();
    model.loadForm({ fields: [...FORM_FIELDS] });

    expect(model.fields.map((field) => field.name)).toEqual(["product", "problem", "vision"]);
    expect(model.fields.map((field) => field.kind)).toEqual(["input", "input", "editor"]);

    model.setValue("product", "SIBYL");
    model.setValue("problem", "no guided originate");
    model.setValue("vision", "a TUI harness for AEP");

    // Editing one field does not touch the others (discrete slots, not a stream).
    expect(model.values()).toEqual({
      product: "SIBYL",
      problem: "no guided originate",
      vision: "a TUI harness for AEP",
    });
  });

  it("tracks decision selection by index and by value", () => {
    const model = new ModalFormModel();
    model.loadDecision(DECISION.prompt, [...DECISION.options]);

    expect(model.decision?.options).toEqual(["Commit", "Revise", "Cancel"]);
    expect(model.selectedChoice).toBe("Commit"); // defaults to the first option

    model.select(1);
    expect(model.selectedChoice).toBe("Revise");

    model.selectChoice("Cancel");
    expect(model.decision?.selectedIndex).toBe(2);
    expect(model.selectedChoice).toBe("Cancel");

    expect(() => model.select(5)).toThrow(RangeError);
    expect(() => model.setValue("nope", "x")).toThrow();
  });
});

describe("SIBYL-007 criterion 1 — form_requested renders fields; submit_form sends values", () => {
  it("collects entered values into the submit_form payload", async () => {
    const { form, dispatched } = capturingForm();

    form.handle({ type: "form_requested", schema: { fields: [...FORM_FIELDS] } });
    expect(form.model.fields.map((field) => field.name)).toEqual([...FORM_FIELDS]);

    form.setValue("product", "SIBYL");
    form.setValue("problem", "no guided originate");
    form.setValue("vision", "a TUI harness");
    await form.submitForm();

    expect(dispatched).toEqual([
      {
        type: "submit_form",
        values: { product: "SIBYL", problem: "no guided originate", vision: "a TUI harness" },
      },
    ]);
  });

  it("renders one editable widget per field (Input for short, Editor for vision)", () => {
    const { form } = capturingForm();
    form.handle({ type: "form_requested", schema: { fields: [...FORM_FIELDS] } });
    const view = headlessView(form);

    expect(view.fieldWidgets.map((field) => field.name)).toEqual([...FORM_FIELDS]);
    expect(view.fieldWidgets[0]?.widget).toBeInstanceOf(Input);
    expect(view.fieldWidgets[1]?.widget).toBeInstanceOf(Input);
    expect(view.fieldWidgets[2]?.widget).toBeInstanceOf(Editor); // long-form README body

    const out = view.render(80).join("\n");
    expect(out).toContain("SIBYL · vision:create");
    for (const field of FORM_FIELDS) {
      expect(out).toContain(`${field}:`);
    }
  });
});

describe("SIBYL-007 criterion 2 — decision_requested renders options; submit_decision sends choice", () => {
  it("emits submit_decision for the chosen option", async () => {
    const { form, dispatched } = capturingForm();

    form.handle({
      type: "decision_requested",
      prompt: DECISION.prompt,
      options: [...DECISION.options],
    });
    expect(form.model.decision?.options).toEqual([...DECISION.options]);

    await form.chooseDecision("Commit");

    expect(dispatched).toEqual([{ type: "submit_decision", choice: "Commit" }]);
  });

  it("submits the index-selected option and renders every option", async () => {
    const { form, dispatched } = capturingForm();
    form.handle({
      type: "decision_requested",
      prompt: DECISION.prompt,
      options: [...DECISION.options],
    });

    const view = headlessView(form);
    expect(view.decisionWidget).toBeInstanceOf(SelectList);
    const out = view.render(80).join("\n");
    expect(out).toContain(DECISION.prompt);
    for (const option of DECISION.options) {
      expect(out).toContain(option);
    }

    form.select(1); // "Revise"
    await form.submitDecision();
    expect(dispatched).toEqual([{ type: "submit_decision", choice: "Revise" }]);
  });
});

describe("SIBYL-007 criterion 3 — a modal form, not a chat transcript (ADR-003)", () => {
  it("is structured as discrete editable fields + a decision selector", () => {
    const { form } = capturingForm();
    form.handle({ type: "form_requested", schema: { fields: [...FORM_FIELDS] } });
    form.handle({
      type: "decision_requested",
      prompt: DECISION.prompt,
      options: [...DECISION.options],
    });
    const view = headlessView(form);

    // Discrete editable fields: exactly one widget per schema field, each a
    // distinct keyed component (the antithesis of one growing message list).
    expect(view.fieldWidgets).toHaveLength(FORM_FIELDS.length);
    const distinct = new Set(view.fieldWidgets.map((field) => field.widget));
    expect(distinct.size).toBe(FORM_FIELDS.length);
    for (const field of view.fieldWidgets) {
      expect(
        field.widget instanceof Input || field.widget instanceof Editor,
        `${field.name} is an editable field`,
      ).toBe(true);
    }

    // A single discrete decision selector, not free-form chat.
    expect(view.decisionWidget).toBeInstanceOf(SelectList);
  });

  it("does not grow a transcript: non-form events never add fields", () => {
    const { form } = capturingForm();
    form.handle({ type: "form_requested", schema: { fields: [...FORM_FIELDS] } });

    // Stream the kinds of events a chat surface would APPEND as messages.
    form.handle({ type: "phase_changed", phase: "running", previous: "form" });
    form.handle({ type: "progress", kind: "message_update", detail: "Drafting README.md" });
    form.handle({ type: "progress", kind: "tool_execution", detail: "git status" });

    // The field set is fixed by the schema — it did not accumulate messages.
    expect(form.model.fields.map((field) => field.name)).toEqual([...FORM_FIELDS]);
    expect(headlessView(form).fieldWidgets).toHaveLength(FORM_FIELDS.length);
  });

  it("imports no Pi SDK / agent (modal-form.ts source scan)", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/renderer/modal-form.ts", import.meta.url)),
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    expect(code).not.toContain("@earendil-works/pi-coding-agent");
    expect(code).not.toContain("@earendil-works/pi-agent");
    expect(code).not.toContain("@earendil-works/pi-ai");
    // It IS a real pi-tui renderer (uses the allowed UI library).
    expect(code).toContain("@earendil-works/pi-tui");
  });
});

describe("createModalForm — drives the form off a live fake-core engine (seam end-to-end)", () => {
  it("collects values → submit_form and a choice → submit_decision through the real seam", async () => {
    const engine = createEngine(originateCore);
    const { form, unsubscribe } = createModalForm(engine);

    const formRequested = waitForType(engine, "form_requested");
    await engine.dispatch({ type: "start_run", cwd: "/abs/empty" });
    await formRequested;
    expect(form.model.fields.map((field) => field.name)).toEqual([...FORM_FIELDS]);

    const decisionRequested = waitForType(engine, "decision_requested");
    form.setValue("product", "SIBYL");
    form.setValue("problem", "no guided originate");
    form.setValue("vision", "a TUI harness");
    await form.submitForm();
    await decisionRequested;
    expect(form.model.decision?.options).toEqual([...DECISION.options]);

    const completed = waitForType(engine, "run_completed");
    await form.chooseDecision("Commit");
    await completed;

    expect(engine.phase).toBe("done");
    unsubscribe();
  });
});
