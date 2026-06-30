import { describe, expect, it } from "vitest";

import {
  createEngine,
  type EngineEvent,
  type EngineRunCore,
  type EngineSeam,
} from "../src/engine/seam";
import { AgentRunView, createApp, deriveStatus, type UiMode } from "../src/renderer/app";
import { formatProgressLine, ProgressLog } from "../src/renderer/progress";

/**
 * A scripted originate-run EngineEvent stream (the exact shapes the engine
 * emits — the renderer owns nothing else). Used to drive the shell WITHOUT a
 * live engine or live TTY.
 */
const SCRIPT: readonly EngineEvent[] = [
  { type: "phase_changed", phase: "form", previous: "idle" },
  { type: "form_requested", schema: { fields: ["product", "problem", "vision"] } },
  { type: "phase_changed", phase: "running", previous: "form" },
  { type: "progress", kind: "tool_execution", detail: "git status --porcelain" },
  { type: "progress", kind: "message_update", detail: "Drafting README.md" },
  { type: "phase_changed", phase: "decision", previous: "running" },
  { type: "decision_requested", prompt: "Commit this README?", options: ["Commit", "Revise"] },
  { type: "phase_changed", phase: "done", previous: "decision" },
  { type: "run_completed", artifacts: ["README.md"], decisions: 1 },
];

/** A fake originate core that walks the phases (no Pi / model call). */
const originateCore: EngineRunCore = {
  startForm: () => ({ fields: ["product", "problem", "vision"] }),
  runToDecision: async (ctx) => {
    ctx.emitProgress({ kind: "tool_execution", detail: "git status --porcelain" });
    ctx.emitProgress({ kind: "message_update", detail: "Drafting README.md" });
    return { prompt: "Commit this README?", options: ["Commit", "Revise"] };
  },
  complete: () => ({ artifacts: ["README.md"], decisions: 1 }),
};

/** Resolve when the engine emits an event of `type` (mirrors a real renderer). */
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

describe("AgentRunView — UI-mode state machine (mirrors engine Phase)", () => {
  it("derives agent_run.status from every phase", () => {
    const expected: Record<UiMode, string> = {
      idle: "idle",
      form: "active",
      running: "active",
      decision: "active",
      done: "completed",
      failed: "failed",
    };
    for (const [phase, status] of Object.entries(expected)) {
      expect(deriveStatus(phase as UiMode)).toBe(status);
    }
  });

  it("transitions UI mode on each phase_changed (and only on phase_changed)", () => {
    const view = new AgentRunView();
    expect(view.mode).toBe("idle"); // empty-state before any run

    const trail: UiMode[] = [];
    for (const event of SCRIPT) {
      const before = view.mode;
      view.handle(event);
      if (event.type === "phase_changed") {
        trail.push(view.mode);
        expect(view.mode).toBe(event.phase);
      } else {
        expect(view.mode).toBe(before); // non-phase events never move the mode
      }
    }

    expect(trail).toEqual(["form", "running", "decision", "done"]);
    expect(view.status).toBe("completed");
  });

  it("appends progress (tool activity + assistant text) on progress events", () => {
    const view = new AgentRunView();
    for (const event of SCRIPT) {
      view.handle(event);
    }

    expect(view.progress).toEqual([
      { kind: "tool_execution", detail: "git status --porcelain" },
      { kind: "message_update", detail: "Drafting README.md" },
    ]);
  });

  it("captures form / decision / completion payloads into the snapshot", () => {
    const view = new AgentRunView();
    for (const event of SCRIPT) {
      view.handle(event);
    }
    const snap = view.snapshot();
    expect(snap.form?.fields).toEqual(["product", "problem", "vision"]);
    expect(snap.decision).toEqual({
      prompt: "Commit this README?",
      options: ["Commit", "Revise"],
    });
    expect(snap.completion).toEqual({ artifacts: ["README.md"], decisions: 1 });
  });
});

describe("AgentRunView — renders the agent_run:detail view (pi-tui, headless)", () => {
  it("renders the empty-state at idle (no TTY required)", () => {
    const view = new AgentRunView();
    const out = view.render(80).join("\n");
    expect(out).toContain("SIBYL · agent run");
    expect(out).toContain("phase: idle");
    expect(out).toContain("status: idle");
    expect(out).toContain("No active run");
  });

  it("reflects phase_changed + progress in the rendered output", () => {
    const view = new AgentRunView();
    for (const event of SCRIPT) {
      view.handle(event);
    }
    const out = view.render(80).join("\n");

    // card_field `phase` + derived status (Object Map agent_run:detail).
    expect(out).toContain("phase: done");
    expect(out).toContain("status: completed");
    // progress_log: tool activity + streaming assistant text.
    expect(out).toContain(
      formatProgressLine({ kind: "tool_execution", detail: "git status --porcelain" }),
    );
    expect(out).toContain(
      formatProgressLine({ kind: "message_update", detail: "Drafting README.md" }),
    );
    expect(out).toContain("[tool] git status --porcelain");
    expect(out).toContain("[text] Drafting README.md");
    // completion detail.
    expect(out).toContain("README.md");
  });

  it("renders a run_failed detail line", () => {
    const view = new AgentRunView();
    view.handle({ type: "phase_changed", phase: "failed", previous: "running" });
    view.handle({ type: "run_failed", class: "tool", detail: "git exited 1" });
    const out = view.render(80).join("\n");
    expect(out).toContain("phase: failed");
    expect(out).toContain("status: failed");
    expect(out).toContain("failed · tool: git exited 1");
  });
});

describe("createApp — consumes ONLY EngineEvents via the seam's subscribe", () => {
  it("drives the shell off a live fake-core engine end-to-end", async () => {
    const engine = createEngine(originateCore);
    const { view, unsubscribe } = createApp(engine);

    const formRequested = waitForType(engine, "form_requested");
    await engine.dispatch({ type: "start_run", cwd: "/abs/empty" });
    await formRequested;
    expect(view.mode).toBe("form");
    expect(view.status).toBe("active");

    const decisionRequested = waitForType(engine, "decision_requested");
    await engine.dispatch({
      type: "submit_form",
      values: { product: "SIBYL", problem: "no guided originate", vision: "a TUI harness" },
    });
    await decisionRequested;
    expect(view.mode).toBe("decision");

    const completed = waitForType(engine, "run_completed");
    await engine.dispatch({ type: "submit_decision", choice: "Commit" });
    await completed;

    expect(view.mode).toBe("done");
    expect(view.status).toBe("completed");
    expect(view.progress).toEqual([
      { kind: "tool_execution", detail: "git status --porcelain" },
      { kind: "message_update", detail: "Drafting README.md" },
    ]);

    const out = view.render(80).join("\n");
    expect(out).toContain("phase: done");
    expect(out).toContain("[tool] git status --porcelain");
    expect(out).toContain("[text] Drafting README.md");

    unsubscribe();
  });
});

describe("ProgressLog — pure append-only model", () => {
  it("appends, formats, and clears", () => {
    const log = new ProgressLog();
    expect(log.size).toBe(0);
    log.append({ kind: "tool_execution", detail: "bun install" });
    log.append({ kind: "message_update", detail: "thinking…" });
    expect(log.size).toBe(2);
    expect(log.lines()).toEqual(["[tool] bun install", "[text] thinking…"]);
    log.clear();
    expect(log.size).toBe(0);
    expect(log.lines()).toEqual([]);
  });
});
