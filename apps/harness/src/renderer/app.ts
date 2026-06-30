/**
 * TUI shell + UI-mode state machine + progress render (SIBYL-006).
 *
 * This is the FACE of the engine↔renderer seam (ADR-001): a custom, non-chat
 * `@earendil-works/pi-tui` renderer that subscribes to {@link EngineEvent}s and
 * renders the `agent_run:detail` screen from the Object Map slice (show `phase`
 * — the card_field — plus the derived `status`, and stream `progress_log`).
 *
 * It consumes ONLY the seam (`EngineEvent` / `subscribe`) and the pi-tui UI
 * library. It does NOT import the Pi SDK / agent
 * (`@earendil-works/pi-coding-agent` / `pi-agent`) — the engine owns the Pi
 * driver and this renderer only ever sees structured events. That invariant is
 * the mirror of SIBYL-002's "no `ctx.ui` in the engine" rule and is proven by a
 * source scan (`test/renderer-no-pi-sdk.test.ts`).
 *
 * The UI-mode state machine mirrors the engine {@link Phase} 1:1 (v0 is
 * "form-mode"): each `phase_changed` advances the UI mode; each `progress`
 * appends to the live progress widget. The pure view logic ({@link AgentRunView})
 * is unit-testable headlessly — its `render(width)` needs no TTY. Only
 * {@link mount} touches a real terminal (`ProcessTerminal` raw TTY), kept
 * separate so the render logic can be tested without a live terminal.
 */

import { Box, Container, ProcessTerminal, Text, TUI } from "@earendil-works/pi-tui";

import type {
  EngineEvent,
  EngineSeam,
  FormSchema,
  Phase,
  RunFailureClass,
  Unsubscribe,
} from "../engine/seam";

import { ProgressLog, ProgressWidget, type ProgressEntry } from "./progress";

/** The renderer's UI mode mirrors the engine {@link Phase} 1:1 (v0 = form-mode). */
export type UiMode = Phase;

/** The `agent_run.status` core attribute (Object Map), derived from the phase. */
export type RunStatus = "idle" | "active" | "completed" | "failed";

/** agent_run:detail screen title. */
const TITLE = "SIBYL · agent run";

/** agent_run:detail empty-state (Object Map `screens.agent_run.empty_state`). */
const EMPTY_STATE = "No active run";

/** Map a {@link Phase} to the derived `agent_run.status`. */
export function deriveStatus(phase: Phase): RunStatus {
  switch (phase) {
    case "idle":
      return "idle";
    case "form":
    case "running":
    case "decision":
      return "active";
    case "done":
      return "completed";
    case "failed":
      return "failed";
    default: {
      const exhaustive: never = phase;
      throw new Error(`Unknown phase: ${String(exhaustive)}`);
    }
  }
}

/** A flat, assertable snapshot of the view's reactive state (for tests). */
export interface ViewSnapshot {
  readonly mode: UiMode;
  readonly status: RunStatus;
  readonly progress: readonly ProgressEntry[];
  readonly form?: FormSchema;
  readonly decision?: { readonly prompt: string; readonly options: readonly string[] };
  readonly completion?: { readonly artifacts: readonly string[]; readonly decisions: number };
  readonly failure?: { readonly class: RunFailureClass; readonly detail: string };
}

/**
 * The `agent_run:detail` view: a pi-tui `Container` (header + progress widget)
 * driven by a UI-mode state machine that mirrors the engine phase. Feed it
 * {@link EngineEvent}s via {@link AgentRunView.handle}; it is pure (no TTY) so
 * `render(width)` and the mode/progress getters are unit-testable headlessly.
 */
export class AgentRunView extends Container {
  #mode: UiMode = "idle";
  #form: FormSchema | undefined;
  #decision: { prompt: string; options: readonly string[] } | undefined;
  #completion: { artifacts: readonly string[]; decisions: number } | undefined;
  #failure: { class: RunFailureClass; detail: string } | undefined;

  readonly #log = new ProgressLog();
  readonly #statusLine = new Text("");
  readonly #detailLine = new Text("");
  readonly #progress = new ProgressWidget(this.#log, EMPTY_STATE);

  constructor() {
    super();
    const header = new Box(1, 0);
    header.addChild(new Text(TITLE));
    header.addChild(this.#statusLine);
    header.addChild(this.#detailLine);
    this.addChild(header);
    this.addChild(new Text("progress"));
    this.addChild(this.#progress);
    this.#sync();
  }

  /** Current UI mode (mirrors the engine phase). */
  get mode(): UiMode {
    return this.#mode;
  }

  /** Derived `agent_run.status` for the current mode. */
  get status(): RunStatus {
    return deriveStatus(this.#mode);
  }

  /** The live progress entries streamed so far. */
  get progress(): readonly ProgressEntry[] {
    return this.#log.entries;
  }

  /** A flat snapshot of reactive state (tests). */
  snapshot(): ViewSnapshot {
    return {
      mode: this.#mode,
      status: this.status,
      progress: this.#log.entries,
      form: this.#form,
      decision: this.#decision,
      completion: this.#completion,
      failure: this.#failure,
    };
  }

  /**
   * Apply one {@link EngineEvent}: advance the UI mode on `phase_changed`,
   * append to the progress log on `progress`, and capture form/decision/
   * completion/failure payloads for the detail line. Re-syncs the rendered
   * header + widget afterwards.
   */
  handle(event: EngineEvent): void {
    switch (event.type) {
      case "phase_changed":
        this.#mode = event.phase;
        break;
      case "progress":
        this.#log.append({ kind: event.kind, detail: event.detail });
        break;
      case "form_requested":
        this.#form = event.schema;
        break;
      case "decision_requested":
        this.#decision = { prompt: event.prompt, options: event.options };
        break;
      case "run_completed":
        this.#completion = { artifacts: event.artifacts, decisions: event.decisions };
        break;
      case "run_failed":
        this.#failure = { class: event.class, detail: event.detail };
        break;
      default: {
        const exhaustive: never = event;
        throw new Error(`Unknown EngineEvent: ${JSON.stringify(exhaustive)}`);
      }
    }
    this.#sync();
  }

  /** Push the current state into the rendered header + progress widget. */
  #sync(): void {
    this.#statusLine.setText(`phase: ${this.#mode}    status: ${this.status}`);
    this.#detailLine.setText(this.#detail());
    this.#progress.invalidate();
  }

  /** The mode-specific detail line (reflects the latest event's payload). */
  #detail(): string {
    switch (this.#mode) {
      case "idle":
        return EMPTY_STATE;
      case "form": {
        const fields = this.#form?.fields.join(", ") ?? "";
        return fields ? `form-mode · collecting ${fields}` : "form-mode";
      }
      case "running":
        return "running · streaming progress";
      case "decision":
        return this.#decision
          ? `decision · ${this.#decision.prompt}  [${this.#decision.options.join(" / ")}]`
          : "decision";
      case "done": {
        if (!this.#completion) {
          return "completed";
        }
        const artifacts = this.#completion.artifacts.join(", ") || "none";
        const plural = this.#completion.decisions === 1 ? "" : "s";
        return `completed · ${artifacts} (${this.#completion.decisions} decision${plural})`;
      }
      case "failed":
        return this.#failure
          ? `failed · ${this.#failure.class}: ${this.#failure.detail}`
          : "failed";
      default: {
        const exhaustive: never = this.#mode;
        throw new Error(`Unknown mode: ${String(exhaustive)}`);
      }
    }
  }
}

/** A headless app: an {@link AgentRunView} subscribed to an engine (no TTY). */
export interface RunningApp {
  readonly view: AgentRunView;
  readonly unsubscribe: Unsubscribe;
}

/**
 * Wire an {@link AgentRunView} to the engine's event stream. This is the pure,
 * headless half of the shell — it only `subscribe`s (no terminal), so it is the
 * surface tests drive with a scripted EngineEvent stream / a fake-core engine.
 */
export function createApp(engine: EngineSeam): RunningApp {
  const view = new AgentRunView();
  const unsubscribe = engine.subscribe((event) => {
    view.handle(event);
  });
  return { view, unsubscribe };
}

/** A mounted app: the headless app plus a live pi-tui {@link TUI} over a TTY. */
export interface MountedApp extends RunningApp {
  readonly tui: TUI;
  /** Unsubscribe from the engine and stop the TUI render loop. */
  stop(): void;
}

/**
 * Mount the shell into a live terminal. This is the ONLY part that touches a
 * real TTY (`ProcessTerminal` puts stdin in raw mode), so it is intentionally
 * separated from {@link createApp} / {@link AgentRunView} and is NOT exercised
 * by the headless tests. Requires `process.stdout.isTTY`; a future CLI entry
 * point (later story) calls this.
 */
export function mount(engine: EngineSeam): MountedApp {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const view = new AgentRunView();
  tui.addChild(view);

  const unsubscribe = engine.subscribe((event) => {
    view.handle(event);
    tui.requestRender();
  });

  tui.start();
  tui.requestRender();

  return {
    view,
    tui,
    unsubscribe,
    stop(): void {
      unsubscribe();
      tui.stop();
    },
  };
}
