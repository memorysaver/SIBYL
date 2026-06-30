/**
 * The engine <-> renderer seam (SIBYL-002, ADR-001).
 *
 * This module defines the load-bearing contract between the host-agnostic
 * engine and ANY consumer (the pi-tui renderer today; the web surface later):
 *
 *   - {@link EngineCommand}: messages the renderer sends INTO the engine
 *     (`engine.dispatch(command)`).
 *   - {@link EngineEvent}: structured events the engine streams OUT
 *     (`engine.subscribe(listener)`).
 *
 * It is renderer-agnostic by construction: there is NO `pi-tui` import and NO
 * `ctx.ui` reference anywhere in the engine. Orchestration speaks only in
 * EngineEvents. The actual Pi-agent-driven originate run is injected as an
 * {@link EngineRunCore} (SIBYL-003 plugs the real Pi driver in here); this layer
 * delivers the contract, the enforced phase machine wiring, and the event
 * stream, and is exercised by a fake core.
 */

import { InvalidTransitionError, PhaseMachine, type Phase, type Transition } from "./state-machine";

export type { Phase } from "./state-machine";

// ---------------------------------------------------------------------------
// Shared payload sub-types (mirrored inside the event/command unions so cores
// produce well-typed values and renderers consume well-typed events).
// ---------------------------------------------------------------------------

/** What a `progress` event describes: a tool step or a streaming-text update. */
export type ProgressKind = "tool_execution" | "message_update";

/** Every {@link ProgressKind}. */
export const PROGRESS_KINDS = [
  "tool_execution",
  "message_update",
] as const satisfies readonly ProgressKind[];

/** The form the engine asks the renderer to collect (originate: product/problem/vision). */
export interface FormSchema {
  readonly fields: readonly string[];
}

/** A single progress report emitted while a run executes. */
export interface ProgressUpdate {
  readonly kind: ProgressKind;
  readonly detail: string;
}

/** A decision the engine asks the renderer to resolve (e.g. "Commit this README?"). */
export interface DecisionRequest {
  readonly prompt: string;
  readonly options: readonly string[];
}

/** The summary of a completed run. */
export interface RunCompletion {
  readonly artifacts: readonly string[];
  readonly decisions: number;
}

/**
 * Classification of a run failure (the `class` of a `run_failed` event):
 *   - `aborted`  — the user issued an `abort` command.
 *   - `agent`    — the Pi agent / model failed.
 *   - `tool`     — a gated tool (e.g. git) failed.
 *   - `protocol` — an out-of-phase command was dispatched (state-machine reject).
 *   - `internal` — an unexpected engine error.
 */
export type RunFailureClass = "aborted" | "agent" | "tool" | "protocol" | "internal";

/** Every {@link RunFailureClass}. */
export const RUN_FAILURE_CLASSES = [
  "aborted",
  "agent",
  "tool",
  "protocol",
  "internal",
] as const satisfies readonly RunFailureClass[];

// ---------------------------------------------------------------------------
// The protocol: EngineEvent (engine -> renderer) and EngineCommand (renderer -> engine).
// ---------------------------------------------------------------------------

/**
 * Events the engine streams to subscribers. A discriminated union on `type`;
 * this is the renderer-facing half of the seam.
 */
export type EngineEvent =
  | { readonly type: "phase_changed"; readonly phase: Phase; readonly previous: Phase }
  | { readonly type: "progress"; readonly kind: ProgressKind; readonly detail: string }
  | { readonly type: "form_requested"; readonly schema: FormSchema }
  | {
      readonly type: "decision_requested";
      readonly prompt: string;
      readonly options: readonly string[];
    }
  | {
      readonly type: "run_completed";
      readonly artifacts: readonly string[];
      readonly decisions: number;
    }
  | { readonly type: "run_failed"; readonly class: RunFailureClass; readonly detail: string };

/**
 * Commands the renderer dispatches into the engine. A discriminated union on
 * `type`; this is the engine-facing half of the seam.
 */
export type EngineCommand =
  | { readonly type: "start_run"; readonly cwd: string }
  | { readonly type: "submit_form"; readonly values: Readonly<Record<string, string>> }
  | { readonly type: "submit_decision"; readonly choice: string }
  | { readonly type: "abort" };

/** Every {@link EngineEvent} discriminant. */
export const ENGINE_EVENT_TYPES = [
  "phase_changed",
  "progress",
  "form_requested",
  "decision_requested",
  "run_completed",
  "run_failed",
] as const satisfies readonly EngineEvent["type"][];

/** Every {@link EngineCommand} discriminant. */
export const ENGINE_COMMAND_TYPES = [
  "start_run",
  "submit_form",
  "submit_decision",
  "abort",
] as const satisfies readonly EngineCommand["type"][];

// ---------------------------------------------------------------------------
// Runtime conformance guards (back the contract test; usable by any consumer).
// ---------------------------------------------------------------------------

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

/** True if `value` structurally conforms to an {@link EngineEvent}. */
export function isEngineEvent(value: unknown): value is EngineEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const event = value as { type?: unknown } & Record<string, unknown>;
  switch (event.type) {
    case "phase_changed":
      return typeof event.phase === "string" && typeof event.previous === "string";
    case "progress":
      return (
        (PROGRESS_KINDS as readonly string[]).includes(event.kind as string) &&
        typeof event.detail === "string"
      );
    case "form_requested":
      return (
        typeof event.schema === "object" &&
        event.schema !== null &&
        isStringArray((event.schema as { fields?: unknown }).fields)
      );
    case "decision_requested":
      return typeof event.prompt === "string" && isStringArray(event.options);
    case "run_completed":
      return isStringArray(event.artifacts) && typeof event.decisions === "number";
    case "run_failed":
      return (
        (RUN_FAILURE_CLASSES as readonly string[]).includes(event.class as string) &&
        typeof event.detail === "string"
      );
    default:
      return false;
  }
}

/** True if `value` structurally conforms to an {@link EngineCommand}. */
export function isEngineCommand(value: unknown): value is EngineCommand {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const command = value as { type?: unknown } & Record<string, unknown>;
  switch (command.type) {
    case "start_run":
      return typeof command.cwd === "string";
    case "submit_form":
      return isStringRecord(command.values);
    case "submit_decision":
      return typeof command.choice === "string";
    case "abort":
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Tiny typed event emitter (no Node `events`, no `any`, renderer-agnostic).
// ---------------------------------------------------------------------------

/** A subscriber to the engine event stream. */
export type EngineEventListener = (event: EngineEvent) => void;

/** Returned by `subscribe`; call to stop receiving events. */
export type Unsubscribe = () => void;

/** Minimal typed fan-out emitter over {@link EngineEvent}. */
export class EngineEventEmitter {
  readonly #listeners = new Set<EngineEventListener>();

  /** Register `listener`; returns an idempotent unsubscribe. */
  subscribe(listener: EngineEventListener): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Fan `event` out to a snapshot of listeners (safe under re-entrant (un)subscribe). */
  emit(event: EngineEvent): void {
    const snapshot = Array.from(this.#listeners);
    for (const listener of snapshot) {
      listener(event);
    }
  }

  /** Current listener count (diagnostics/tests). */
  get size(): number {
    return this.#listeners.size;
  }
}

// ---------------------------------------------------------------------------
// The seam surface + the injected run core.
// ---------------------------------------------------------------------------

/** The engine <-> renderer seam surface (ADR-001 interface). */
export interface EngineSeam {
  /** Send a command into the engine. Rejects on an out-of-phase command. */
  dispatch(command: EngineCommand): Promise<void>;
  /** Subscribe to the engine event stream. */
  subscribe(listener: EngineEventListener): Unsubscribe;
}

/** The engine returned by {@link createEngine}: the seam plus read-only diagnostics. */
export interface Engine extends EngineSeam {
  /** The current run phase (for tests/diagnostics; renderers should track `phase_changed`). */
  readonly phase: Phase;
}

/** Context passed to {@link EngineRunCore.startForm} (idle -> form). */
export interface StartContext {
  readonly cwd: string;
  readonly signal: AbortSignal;
}

/** Context passed to {@link EngineRunCore.runToDecision} (form -> running -> decision). */
export interface RunContext {
  readonly cwd: string;
  readonly values: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  /** Emit a `progress` event to all subscribers. */
  emitProgress(update: ProgressUpdate): void;
}

/** Context passed to {@link EngineRunCore.complete} (decision -> done). */
export interface CompleteContext {
  readonly cwd: string;
  readonly values: Readonly<Record<string, string>>;
  readonly choice: string;
  readonly signal: AbortSignal;
}

/**
 * The orchestration core the engine drives across the phase machine. This is
 * the seam's *injection point*: a fake core walks the phases in tests; SIBYL-003
 * implements it over the Pi `AgentSession`. The core never touches the event
 * stream directly except via {@link RunContext.emitProgress}; phase transitions
 * and lifecycle events are owned by the engine.
 */
export interface EngineRunCore {
  /** idle -> form: produce the form schema to request from the renderer. */
  startForm(ctx: StartContext): FormSchema | Promise<FormSchema>;
  /**
   * form -> running -> decision: drive the run, emitting progress via
   * `ctx.emitProgress`, then resolve with the decision to request. Throw (or
   * reject) — optionally with a {@link RunFailure} — to fail the run.
   */
  runToDecision(ctx: RunContext): DecisionRequest | Promise<DecisionRequest>;
  /** decision -> done: finalize after the renderer submits the decision. */
  complete(ctx: CompleteContext): RunCompletion | Promise<RunCompletion>;
}

/**
 * Error a core may throw to control the `run_failed` classification. Anything
 * else maps to `internal` (or `aborted` for an `AbortError`).
 */
export class RunFailure extends Error {
  readonly failureClass: RunFailureClass;

  constructor(failureClass: RunFailureClass, detail: string) {
    super(detail);
    this.name = "RunFailure";
    this.failureClass = failureClass;
  }
}

function classifyFailure(error: unknown): { failureClass: RunFailureClass; detail: string } {
  if (error instanceof RunFailure) {
    return { failureClass: error.failureClass, detail: error.message };
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return { failureClass: "aborted", detail: error.message };
    }
    return { failureClass: "internal", detail: error.message };
  }
  return { failureClass: "internal", detail: String(error) };
}

// ---------------------------------------------------------------------------
// The engine: wires the command surface to the phase machine + event stream.
// ---------------------------------------------------------------------------

class EngineImpl implements Engine {
  readonly #emitter = new EngineEventEmitter();
  readonly #machine = new PhaseMachine();
  readonly #core: EngineRunCore;

  #cwd = "";
  #values: Readonly<Record<string, string>> = {};
  #abort: AbortController = new AbortController();

  constructor(core: EngineRunCore) {
    this.#core = core;
  }

  get phase(): Phase {
    return this.#machine.phase;
  }

  subscribe(listener: EngineEventListener): Unsubscribe {
    return this.#emitter.subscribe(listener);
  }

  async dispatch(command: EngineCommand): Promise<void> {
    switch (command.type) {
      case "start_run":
        return this.#handleStart(command.cwd);
      case "submit_form":
        return this.#handleSubmitForm(command.values);
      case "submit_decision":
        return this.#handleSubmitDecision(command.choice);
      case "abort":
        return this.#handleAbort();
      default: {
        const exhaustive: never = command;
        throw new Error(`Unknown EngineCommand: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /** Strict transition (command-driven): throws to reject an out-of-phase command. */
  #transition(transition: Transition): void {
    const { from, to } = this.#machine.apply(transition);
    this.#emitter.emit({ type: "phase_changed", phase: to, previous: from });
  }

  /** Guarded transition (engine-internal): no-ops if already terminal/illegal. */
  #tryTransition(transition: Transition): boolean {
    if (this.#machine.done || !this.#machine.can(transition)) {
      return false;
    }
    const { from, to } = this.#machine.apply(transition);
    this.#emitter.emit({ type: "phase_changed", phase: to, previous: from });
    return true;
  }

  #fail(error: unknown): void {
    if (this.#machine.done) {
      return;
    }
    const { failureClass, detail } = classifyFailure(error);
    this.#tryTransition(failureClass === "aborted" ? "abort" : "fail");
    this.#emitter.emit({ type: "run_failed", class: failureClass, detail });
  }

  async #handleStart(cwd: string): Promise<void> {
    this.#transition("start"); // idle -> form (rejects dispatch if not idle)
    this.#cwd = cwd;
    this.#abort = new AbortController();

    let schema: FormSchema;
    try {
      schema = await this.#core.startForm({ cwd, signal: this.#abort.signal });
    } catch (error) {
      this.#fail(error);
      return;
    }
    if (!this.#machine.done) {
      this.#emitter.emit({ type: "form_requested", schema });
    }
  }

  async #handleSubmitForm(values: Readonly<Record<string, string>>): Promise<void> {
    this.#transition("submit_form"); // form -> running (rejects dispatch if not in form)
    this.#values = { ...values };

    const ctx: RunContext = {
      cwd: this.#cwd,
      values: this.#values,
      signal: this.#abort.signal,
      emitProgress: (update) => {
        if (!this.#machine.done) {
          this.#emitter.emit({ type: "progress", kind: update.kind, detail: update.detail });
        }
      },
    };

    // Kick the run off in the background: progress + decision_requested flow as
    // EVENTS, not via this dispatch promise (the renderer reacts to the stream).
    void this.#driveRun(ctx);
  }

  async #driveRun(ctx: RunContext): Promise<void> {
    let decision: DecisionRequest;
    try {
      decision = await this.#core.runToDecision(ctx);
    } catch (error) {
      this.#fail(error);
      return;
    }
    if (this.#tryTransition("request_decision")) {
      // running -> decision
      this.#emitter.emit({
        type: "decision_requested",
        prompt: decision.prompt,
        options: [...decision.options],
      });
    }
  }

  async #handleSubmitDecision(choice: string): Promise<void> {
    // Enforce phase up-front; the actual transition is deferred until `complete`
    // resolves so a failing finalize can still land in `failed`.
    if (!this.#machine.can("submit_decision")) {
      throw new InvalidTransitionError(this.#machine.phase, "submit_decision");
    }

    let completion: RunCompletion;
    try {
      completion = await this.#core.complete({
        cwd: this.#cwd,
        values: this.#values,
        choice,
        signal: this.#abort.signal,
      });
    } catch (error) {
      this.#fail(error); // decision -> failed
      return;
    }

    if (this.#tryTransition("submit_decision")) {
      // decision -> done
      this.#emitter.emit({
        type: "run_completed",
        artifacts: [...completion.artifacts],
        decisions: completion.decisions,
      });
    }
  }

  async #handleAbort(): Promise<void> {
    if (this.#machine.done) {
      return; // abort after the run already settled is a no-op
    }
    this.#abort.abort();
    this.#tryTransition("abort"); // active -> failed
    this.#emitter.emit({ type: "run_failed", class: "aborted", detail: "Run aborted by user." });
  }
}

/**
 * Create an {@link Engine} that drives `core` across the run/phase state machine
 * and streams {@link EngineEvent}s. The core is the injection point for the real
 * Pi-agent originate run (SIBYL-003); tests pass a fake core.
 */
export function createEngine(core: EngineRunCore): Engine {
  return new EngineImpl(core);
}
