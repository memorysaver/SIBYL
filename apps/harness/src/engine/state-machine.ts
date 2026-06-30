/**
 * Run/phase state machine for the SIBYL engine (SIBYL-002).
 *
 * This module is the single owner of the `Phase` concept and the transition
 * table that the engine seam enforces. It is PURE: no Pi SDK, no pi-tui, no
 * `ctx.ui`, no I/O. The seam ({@link ./seam.ts}) drives it and translates the
 * resulting phase changes into `phase_changed` EngineEvents.
 *
 * Phase lifecycle (ADR-001 / `originate-run`):
 *   idle -> form -> running -> decision -> done   (happy path)
 *   any active phase -> failed                    (abort / failure)
 */

/** The phases a run moves through. `done` and `failed` are terminal. */
export type Phase = "idle" | "form" | "running" | "decision" | "done" | "failed";

/** All phases, in lifecycle order. Source of truth for the phase set. */
export const PHASES = [
  "idle",
  "form",
  "running",
  "decision",
  "done",
  "failed",
] as const satisfies readonly Phase[];

/** Terminal phases — once reached, no further transition is allowed. */
export const TERMINAL_PHASES = ["done", "failed"] as const satisfies readonly Phase[];

/**
 * Named triggers that drive phase transitions. These are the *transitions* of
 * the machine (distinct from EngineCommands: e.g. `request_decision` is an
 * engine-internal step, not a renderer command, and both `abort` and `fail`
 * land in `failed`).
 */
export type Transition =
  | "start" // idle     -> form
  | "submit_form" // form     -> running
  | "request_decision" // running  -> decision
  | "submit_decision" // decision -> done
  | "abort" // active   -> failed
  | "fail"; // active   -> failed

/** All transition names. */
export const TRANSITIONS = [
  "start",
  "submit_form",
  "request_decision",
  "submit_decision",
  "abort",
  "fail",
] as const satisfies readonly Transition[];

/**
 * The transition table. `TRANSITION_TABLE[from][t]` is the resulting phase, or
 * `undefined` if `t` is not legal from `from`. `abort`/`fail` are legal from
 * every non-terminal phase; the terminal phases (`done`, `failed`) accept
 * nothing.
 */
export const TRANSITION_TABLE: Readonly<
  Record<Phase, Readonly<Partial<Record<Transition, Phase>>>>
> = {
  idle: { start: "form", abort: "failed", fail: "failed" },
  form: { submit_form: "running", abort: "failed", fail: "failed" },
  running: { request_decision: "decision", abort: "failed", fail: "failed" },
  decision: { submit_decision: "done", abort: "failed", fail: "failed" },
  done: {},
  failed: {},
};

/** True if `phase` is terminal (`done` or `failed`). */
export function isTerminal(phase: Phase): boolean {
  return phase === "done" || phase === "failed";
}

/**
 * Resolve the next phase for `(from, transition)`, or `undefined` if the
 * transition is not legal from `from`.
 */
export function nextPhase(from: Phase, transition: Transition): Phase | undefined {
  return TRANSITION_TABLE[from][transition];
}

/** True if `transition` is legal from `from`. */
export function canTransition(from: Phase, transition: Transition): boolean {
  return nextPhase(from, transition) !== undefined;
}

/** Thrown when an illegal transition is attempted against the machine. */
export class InvalidTransitionError extends Error {
  constructor(
    readonly from: Phase,
    readonly transition: Transition,
  ) {
    super(`Invalid transition '${transition}' from phase '${from}'`);
    this.name = "InvalidTransitionError";
  }
}

/**
 * A tiny stateful wrapper over {@link TRANSITION_TABLE} that the engine seam
 * holds to enforce run/phase ordering. Construct fresh per run.
 */
export class PhaseMachine {
  #phase: Phase;

  constructor(initial: Phase = "idle") {
    this.#phase = initial;
  }

  /** The current phase. */
  get phase(): Phase {
    return this.#phase;
  }

  /** True if the current phase is terminal. */
  get done(): boolean {
    return isTerminal(this.#phase);
  }

  /** True if `transition` is legal from the current phase. */
  can(transition: Transition): boolean {
    return canTransition(this.#phase, transition);
  }

  /**
   * Apply `transition`, advancing the phase. Throws {@link InvalidTransitionError}
   * (without mutating state) when the transition is illegal from the current
   * phase. Returns the phase moved *from* so callers can build `phase_changed`.
   */
  apply(transition: Transition): { from: Phase; to: Phase } {
    const to = nextPhase(this.#phase, transition);
    if (to === undefined) {
      throw new InvalidTransitionError(this.#phase, transition);
    }
    const from = this.#phase;
    this.#phase = to;
    return { from, to };
  }
}
