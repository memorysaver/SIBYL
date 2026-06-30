import { describe, expect, it } from "vitest";

import {
  canTransition,
  InvalidTransitionError,
  isTerminal,
  nextPhase,
  PHASES,
  PhaseMachine,
  TERMINAL_PHASES,
  TRANSITION_TABLE,
  TRANSITIONS,
  type Phase,
  type Transition,
} from "../src/engine/state-machine";

// The full expected transition table (acceptance criterion 3):
// idle -> form -> running -> decision -> done, plus abort/fail -> failed.
const EXPECTED: Record<Phase, Partial<Record<Transition, Phase>>> = {
  idle: { start: "form", abort: "failed", fail: "failed" },
  form: { submit_form: "running", abort: "failed", fail: "failed" },
  running: { request_decision: "decision", abort: "failed", fail: "failed" },
  decision: { submit_decision: "done", abort: "failed", fail: "failed" },
  done: {},
  failed: {},
};

describe("phase set (unit)", () => {
  it("declares the canonical phases and terminal phases", () => {
    expect([...PHASES]).toEqual(["idle", "form", "running", "decision", "done", "failed"]);
    expect([...TERMINAL_PHASES]).toEqual(["done", "failed"]);
  });

  it("marks only done/failed terminal", () => {
    expect(PHASES.filter((p) => isTerminal(p))).toEqual(["done", "failed"]);
  });
});

describe("transition table (unit)", () => {
  it("matches the canonical idle->form->running->decision->done/failed table", () => {
    expect(TRANSITION_TABLE).toEqual(EXPECTED);
  });

  it("nextPhase / canTransition agree with the table for EVERY phase x transition", () => {
    for (const from of PHASES) {
      for (const transition of TRANSITIONS) {
        const expected = EXPECTED[from][transition];
        expect(nextPhase(from, transition)).toBe(expected);
        expect(canTransition(from, transition)).toBe(expected !== undefined);
      }
    }
  });

  it("allows abort and fail from every non-terminal phase, never from terminal", () => {
    for (const from of PHASES) {
      const terminal = isTerminal(from);
      expect(canTransition(from, "abort")).toBe(!terminal);
      expect(canTransition(from, "fail")).toBe(!terminal);
    }
  });

  it("rejects every transition out of a terminal phase", () => {
    for (const terminal of TERMINAL_PHASES) {
      for (const transition of TRANSITIONS) {
        expect(canTransition(terminal, transition)).toBe(false);
      }
    }
  });
});

describe("PhaseMachine (unit)", () => {
  it("walks the full happy-path lifecycle", () => {
    const machine = new PhaseMachine();
    expect(machine.phase).toBe("idle");

    expect(machine.apply("start")).toEqual({ from: "idle", to: "form" });
    expect(machine.apply("submit_form")).toEqual({ from: "form", to: "running" });
    expect(machine.apply("request_decision")).toEqual({ from: "running", to: "decision" });
    expect(machine.apply("submit_decision")).toEqual({ from: "decision", to: "done" });

    expect(machine.phase).toBe("done");
    expect(machine.done).toBe(true);
  });

  it("throws InvalidTransitionError on an illegal transition WITHOUT mutating phase", () => {
    const machine = new PhaseMachine();
    expect(() => machine.apply("submit_form")).toThrow(InvalidTransitionError);
    // phase is unchanged after the rejected transition.
    expect(machine.phase).toBe("idle");
    expect(machine.can("submit_form")).toBe(false);
    expect(machine.can("start")).toBe(true);
  });

  it("routes abort to failed from each active phase", () => {
    for (const active of ["idle", "form", "running", "decision"] as const) {
      const machine = new PhaseMachine(active);
      expect(machine.apply("abort")).toEqual({ from: active, to: "failed" });
      expect(machine.phase).toBe("failed");
      // failed is terminal: nothing else applies.
      expect(machine.can("start")).toBe(false);
      expect(() => machine.apply("fail")).toThrow(InvalidTransitionError);
    }
  });

  it("carries the rejected (from, transition) on the error", () => {
    const machine = new PhaseMachine("done");
    try {
      machine.apply("start");
      expect.unreachable("expected InvalidTransitionError");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      expect((error as InvalidTransitionError).from).toBe("done");
      expect((error as InvalidTransitionError).transition).toBe("start");
    }
  });
});
