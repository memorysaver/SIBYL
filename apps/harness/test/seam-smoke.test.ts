import { describe, expect, it } from "vitest";

import {
  createEngine,
  isEngineEvent,
  RunFailure,
  type EngineEvent,
  type EngineRunCore,
  type EngineSeam,
} from "../src/engine/seam";
import { InvalidTransitionError } from "../src/engine/state-machine";

/**
 * A renderer-agnostic test harness: it consumes ONLY EngineEvents (never the Pi
 * SDK, never pi-tui) and lets a test await the next event of a given type — the
 * same surface a real renderer has. Proves the seam is consumable headlessly.
 */
function harness(engine: EngineSeam) {
  const events: EngineEvent[] = [];
  const waiters: { type: EngineEvent["type"]; resolve: (event: EngineEvent) => void }[] = [];

  engine.subscribe((event) => {
    events.push(event);
    const index = waiters.findIndex((waiter) => waiter.type === event.type);
    if (index !== -1) {
      const [waiter] = waiters.splice(index, 1);
      waiter?.resolve(event);
    }
  });

  return {
    events,
    types: () => events.map((event) => event.type),
    waitFor: (type: EngineEvent["type"]) =>
      new Promise<EngineEvent>((resolve) => {
        waiters.push({ type, resolve });
      }),
  };
}

/** A fake originate core that walks the phases without any Pi / model call. */
const originateCore: EngineRunCore = {
  startForm: () => ({ fields: ["product", "problem", "vision"] }),
  runToDecision: async (ctx) => {
    ctx.emitProgress({ kind: "tool_execution", detail: "git status --porcelain" });
    ctx.emitProgress({ kind: "message_update", detail: "Drafting README.md" });
    return { prompt: "Commit this README?", options: ["Commit", "Revise", "Cancel"] };
  },
  complete: () => ({ artifacts: ["README.md"], decisions: 1 }),
};

describe("engine seam — originate run (integration, headless)", () => {
  it("drives a full originate run end-to-end via EngineEvents only", async () => {
    const engine = createEngine(originateCore);
    const h = harness(engine);

    // renderer: start_run -> engine: form_requested
    const form = h.waitFor("form_requested");
    await engine.dispatch({ type: "start_run", cwd: "/abs/empty" });
    expect(await form).toMatchObject({
      type: "form_requested",
      schema: { fields: ["product", "problem", "vision"] },
    });

    // renderer: submit_form -> engine: progress(repeated) -> decision_requested
    const decision = h.waitFor("decision_requested");
    await engine.dispatch({
      type: "submit_form",
      values: { product: "SIBYL", problem: "no guided originate", vision: "a TUI harness" },
    });
    expect(await decision).toMatchObject({
      type: "decision_requested",
      prompt: "Commit this README?",
      options: ["Commit", "Revise", "Cancel"],
    });

    // renderer: submit_decision -> engine: run_completed
    const completed = h.waitFor("run_completed");
    await engine.dispatch({ type: "submit_decision", choice: "Commit" });
    expect(await completed).toMatchObject({
      type: "run_completed",
      artifacts: ["README.md"],
      decisions: 1,
    });

    // The exact originate-run event stream (product-context protocol order).
    expect(h.types()).toEqual([
      "phase_changed", // idle -> form
      "form_requested",
      "phase_changed", // form -> running
      "progress",
      "progress",
      "phase_changed", // running -> decision
      "decision_requested",
      "phase_changed", // decision -> done
      "run_completed",
    ]);

    // The phase_changed trail traces the enforced lifecycle.
    const phaseTrail = h.events
      .filter(
        (event): event is Extract<EngineEvent, { type: "phase_changed" }> =>
          event.type === "phase_changed",
      )
      .map((event) => event.phase);
    expect(phaseTrail).toEqual(["form", "running", "decision", "done"]);

    expect(engine.phase).toBe("done");
    // Every emitted event conforms to the EngineEvent schema.
    expect(h.events.every((event) => isEngineEvent(event))).toBe(true);
  });

  it("aborts mid-run: emits run_failed{aborted} and lands in failed", async () => {
    const blockingCore: EngineRunCore = {
      startForm: () => ({ fields: ["product"] }),
      runToDecision: (ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
      complete: () => ({ artifacts: [], decisions: 0 }),
    };

    const engine = createEngine(blockingCore);
    const h = harness(engine);

    await engine.dispatch({ type: "start_run", cwd: "/abs" });
    await engine.dispatch({ type: "submit_form", values: { product: "x" } });
    expect(engine.phase).toBe("running");

    const failed = h.waitFor("run_failed");
    await engine.dispatch({ type: "abort" });
    const event = (await failed) as Extract<EngineEvent, { type: "run_failed" }>;

    expect(event.class).toBe("aborted");
    expect(engine.phase).toBe("failed");
    // Exactly one run_failed (no double-fail from the rejected core promise).
    expect(h.types().filter((type) => type === "run_failed")).toHaveLength(1);
  });

  it("classifies a core RunFailure into run_failed{class, detail}", async () => {
    const failingCore: EngineRunCore = {
      startForm: () => ({ fields: ["product"] }),
      runToDecision: () => {
        throw new RunFailure("tool", "git exited 1");
      },
      complete: () => ({ artifacts: [], decisions: 0 }),
    };

    const engine = createEngine(failingCore);
    const h = harness(engine);

    await engine.dispatch({ type: "start_run", cwd: "/abs" });
    const failed = h.waitFor("run_failed");
    await engine.dispatch({ type: "submit_form", values: { product: "x" } });

    expect(await failed).toMatchObject({
      type: "run_failed",
      class: "tool",
      detail: "git exited 1",
    });
    expect(engine.phase).toBe("failed");
  });

  it("enforces the state machine at the seam: out-of-phase commands reject", async () => {
    const engine = createEngine(originateCore);

    // submit_form before start_run is illegal (idle has no submit_form).
    await expect(engine.dispatch({ type: "submit_form", values: {} })).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
    // submit_decision before a decision is requested is illegal.
    await expect(engine.dispatch({ type: "submit_decision", choice: "x" })).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );

    expect(engine.phase).toBe("idle");
  });
});
