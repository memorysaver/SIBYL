/**
 * SIBYL-008: End-to-end Originate journey (integration) — the Layer-0 walking
 * skeleton.
 *
 * This is the COMPOSITION ROOT that wires the already-merged building blocks into
 * one runnable pipeline:
 *
 *   renderer  ←→  engine  ←→  tools  ←→  memory
 *
 *   - {@link runOriginate} drives the full headless loop: it composes
 *     `createEngine(createOriginateCore(...))` (SIBYL-002/003), subscribes the
 *     headless renderer (`createApp` + `createModalForm`, SIBYL-006/007), drives
 *     the modal-form CONTROLLER (no raw `submit_form`/`submit_decision` commands
 *     are hand-built — only the lifecycle `start_run`), and on completion persists
 *     the human's commit decision to decision-memory (`appendDecision`, SIBYL-005)
 *     so it is recallable via `recallDecisions`.
 *   - {@link mountOriginate} is the LIVE path: it composes the `ModalFormView`
 *     beside the shell's `AgentRunView` under ONE shared pi-tui `TUI` (the only
 *     code that touches a real TTY).
 *   - {@link createScriptedConnect} is the non-interactive `connect` port: a
 *     scripted `OriginateSession` that emits the REAL Pi `AgentSessionEvent`
 *     shapes producing imagine output, so the journey/test run deterministically
 *     with NO live model.
 *   - {@link runCli} is the CLI dispatcher backing the `sibyl` bin
 *     (`--version` / `originate` / `decisions ls`) that the Tier-2 walking-skeleton
 *     journey dogfoods.
 *
 * The user types NO raw Pi/git commands: form values + the commit choice flow
 * through the modal-form controller, the engine drives the Pi agent and the narrow
 * git tool, and the decision lands in memory.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TUI } from "@earendil-works/pi-tui";

import {
  createOriginateCore,
  COMMIT_CHOICE,
  type OriginateConnect,
  type OriginateSession,
} from "./engine/originate";
import { createEngine, type EngineEvent, type EngineSeam, type Unsubscribe } from "./engine/seam";
import { bootSession } from "./engine/session";
import { appendDecision, recallDecisions, type DecisionEntry } from "./memory/decisions";
import { AgentRunView, createApp } from "./renderer/app";
import { createModalForm, ModalForm, ModalFormView } from "./renderer/modal-form";

// ---------------------------------------------------------------------------
// Version + constants.
// ---------------------------------------------------------------------------

/** Harness version surfaced by `sibyl --version` (mirrors package.json). */
export const SIBYL_VERSION = "0.0.0";

/** The run phase a decision is captured under (decision-memory `phase`). */
const ORIGINATE_PHASE = "originate";

/** The originate form fields the harness seeds in non-interactive mode. */
const ORIGINATE_FIELDS = ["product", "problem", "vision"] as const;

/** CLI mirror of the recalled decision log, written under the run cwd. */
const DECISIONS_MIRROR = join(".sibyl", "decisions.json");

/**
 * The harness package dir (resolves to `apps/harness`). The decision-memory
 * session is booted here — its cwd only governs skill/extension discovery; the
 * decisions themselves live in the explicit in-memory `SessionManager`. Booting
 * here (rather than in an empty run cwd) mirrors `test/decisions.test.ts`.
 */
const HARNESS_DIR = fileURLToPath(new URL("..", import.meta.url));

// ---------------------------------------------------------------------------
// Scripted connect port (real Pi event shapes, no live model).
// ---------------------------------------------------------------------------

/** A type-faithful Pi assistant message (matches `AssistantMessage`). */
function assistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "anthropic",
    provider: "anthropic",
    model: "scripted-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: 0,
  };
}

/**
 * Build a realistic imagine-pass event stream: a read-only tool round-trip, then
 * the assistant streaming `readme` as `text_delta`s, terminated by `agent_end`.
 * These are the REAL `AgentSessionEvent` shapes (verified against
 * `@earendil-works/pi-coding-agent@0.80.2`, mirrored from `test/originate.test.ts`).
 */
function imagineScript(readme: string): AgentSessionEvent[] {
  const deltas = toDeltas(readme);
  const message = assistantMessage(deltas.join(""));
  const events: AgentSessionEvent[] = [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "tool_execution_start", toolCallId: "t1", toolName: "ls", args: { path: "." } },
    {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "ls",
      result: { entries: [] },
      isError: false,
    },
    { type: "message_start", message },
  ];
  for (const delta of deltas) {
    events.push({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message },
    });
  }
  events.push({ type: "message_end", message });
  events.push({ type: "turn_end", message, toolResults: [] });
  events.push({ type: "agent_end", messages: [message], willRetry: false });
  return events;
}

/** Split `text` into `count` contiguous slices so the stream emits >1 delta. */
function toDeltas(text: string, count = 3): string[] {
  if (text.length === 0) {
    return [];
  }
  const size = Math.ceil(text.length / count);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

/** A scripted `OriginateSession` double that emits real Pi events on `prompt`. */
class ScriptedSession implements OriginateSession {
  activeTools: string[] = [];
  readonly prompts: string[] = [];
  disposed = false;

  readonly #script: AgentSessionEvent[];
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();

  constructor(script: AgentSessionEvent[]) {
    this.#script = script;
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  setActiveToolsByName(toolNames: string[]): void {
    this.activeTools = [...toolNames];
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    for (const event of this.#script) {
      for (const listener of Array.from(this.#listeners)) {
        listener(event);
      }
    }
  }

  abort(): void {
    // no-op: the scripted stream is synchronous and never in-flight.
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** A deterministic README the scripted imagine pass streams, seeded by the form. */
export function scriptedReadme(values: Readonly<Record<string, string>>): string {
  const title = values.product?.trim() || "New Project";
  const problem = values.problem?.trim() || "(unspecified)";
  const vision = values.vision?.trim() || "(unspecified)";
  return [
    `# ${title}`,
    "",
    "> Imagined by SIBYL during the originate walking skeleton.",
    "",
    "## Problem",
    "",
    problem,
    "",
    "## Vision",
    "",
    vision,
    "",
  ].join("\n");
}

/** Options for {@link createScriptedConnect}. */
export interface ScriptedConnectOptions {
  /** The README body the scripted agent streams (defaults to a values-seeded one). */
  readme?: string;
  /** The form values used to seed the default README when `readme` is omitted. */
  values?: Readonly<Record<string, string>>;
}

/**
 * Build a non-interactive `connect` port: every connection yields a fresh
 * {@link ScriptedSession} that emits real Pi `AgentSessionEvent`s producing the
 * imagine README — the deterministic stand-in for a live model used by the CLI's
 * non-interactive `originate` and the integration test.
 */
export function createScriptedConnect(options: ScriptedConnectOptions = {}): OriginateConnect {
  const readme = options.readme ?? scriptedReadme(options.values ?? {});
  return async () => new ScriptedSession(imagineScript(readme));
}

// ---------------------------------------------------------------------------
// Event coordination (await EngineEvents while the run streams in the background).
// ---------------------------------------------------------------------------

interface PendingWaiter {
  readonly match: (event: EngineEvent) => boolean;
  readonly resolve: (event: EngineEvent) => void;
}

/** Records the engine stream and lets callers await the next matching event. */
class EventCoordinator {
  readonly events: EngineEvent[] = [];
  readonly #waiters: PendingWaiter[] = [];

  observe(event: EngineEvent): void {
    this.events.push(event);
    for (let i = this.#waiters.length - 1; i >= 0; i--) {
      const waiter = this.#waiters[i];
      if (waiter && waiter.match(event)) {
        this.#waiters.splice(i, 1);
        waiter.resolve(event);
      }
    }
  }

  /** Resolve with the next event whose `type` is in `types`. */
  next(types: readonly EngineEvent["type"][]): Promise<EngineEvent> {
    return new Promise((resolve) => {
      this.#waiters.push({ match: (event) => types.includes(event.type), resolve });
    });
  }
}

// ---------------------------------------------------------------------------
// Decision-memory wiring (a session whose `pi.appendEntry` targets our store).
// ---------------------------------------------------------------------------

interface MemoryHandle {
  readonly pi: ExtensionAPI;
  readonly sessionManager: SessionManager;
  dispose(): Promise<void>;
}

/**
 * Boot a minimal Pi session that captures the real `ExtensionAPI`, so
 * `appendDecision(pi, …)` persists through the genuine `pi.appendEntry` path into
 * `sessionManager` (the same wiring `test/decisions.test.ts` proves).
 */
async function openDecisionMemory(sessionManager: SessionManager): Promise<MemoryHandle> {
  let captured: ExtensionAPI | undefined;
  const captureFactory: ExtensionFactory = (api: ExtensionAPI) => {
    captured = api;
  };
  const { session } = await bootSession(HARNESS_DIR, {
    sessionManager,
    extensionFactories: [captureFactory],
  });
  if (!captured) {
    await session.dispose();
    throw new Error("Pi ExtensionAPI was not captured while opening decision memory");
  }
  return {
    pi: captured,
    sessionManager,
    dispose: () => Promise.resolve(session.dispose()),
  };
}

// ---------------------------------------------------------------------------
// The composed headless pipeline.
// ---------------------------------------------------------------------------

/** Options for {@link runOriginate}. */
export interface RunOriginateOptions {
  /** The (typically empty) working directory the README is written + committed in. */
  cwd: string;
  /** Seeded originate form values (`product` / `problem` / `vision`). */
  values: Readonly<Record<string, string>>;
  /** The auto-confirmed decision choice. Default: `"Commit"`. */
  decision?: string;
  /** Override the agent `connect` port. Default: a scripted, values-seeded one. */
  connect?: OriginateConnect;
  /** Override the commit message used by the git tool. */
  commitMessage?: string;
  /** Provide the decision-memory store (e.g. to recall across calls). */
  sessionManager?: SessionManager;
  /** Timestamp source for the persisted decision (deterministic in tests). */
  now?: () => number;
  /** Observe every EngineEvent as it streams (the CLI prints live progress here). */
  onEvent?: (event: EngineEvent) => void;
}

/** The outcome of a {@link runOriginate} pass. */
export interface OriginateRunResult {
  readonly cwd: string;
  /** The full ordered EngineEvent stream (proves the pipeline flowed end-to-end). */
  readonly events: readonly EngineEvent[];
  /** The completion summary, if the run reached `done`. */
  readonly completion?: { readonly artifacts: readonly string[]; readonly decisions: number };
  /** The failure, if the run reached `failed`. */
  readonly failure?: { readonly class: string; readonly detail: string };
  /** Decisions recalled from memory after the run (`recallDecisions`). */
  readonly decisions: readonly DecisionEntry[];
  /** The decision-memory store (recall again, or assert directly). */
  readonly sessionManager: SessionManager;
  /** The headless shell view (its progress log reflects the streamed activity). */
  readonly view: AgentRunView;
  /** The modal-form controller that drove the form + decision input. */
  readonly form: ModalForm;
}

function progressOf(events: readonly EngineEvent[]): Extract<EngineEvent, { type: "progress" }>[] {
  return events.filter(
    (event): event is Extract<EngineEvent, { type: "progress" }> => event.type === "progress",
  );
}

/**
 * Drive the FULL originate pipeline headlessly: compose engine + headless
 * renderer + decision-memory, drive the modal-form controller with the seeded
 * values + decision choice, and on completion persist the decision. Returns once
 * the run settles (`run_completed` or `run_failed`). This is the non-interactive
 * entry the CLI and the integration test share.
 */
export async function runOriginate(options: RunOriginateOptions): Promise<OriginateRunResult> {
  const decision = options.decision ?? COMMIT_CHOICE;
  const now = options.now ?? Date.now;
  const connect = options.connect ?? createScriptedConnect({ values: options.values });
  const sessionManager = options.sessionManager ?? SessionManager.inMemory(HARNESS_DIR);

  const memory = await openDecisionMemory(sessionManager);

  const engine = createEngine(
    createOriginateCore({ connect, commitMessage: options.commitMessage }),
  );

  // Headless renderer: the shell view + the modal-form controller both subscribe.
  const app = createApp(engine);
  const modal = createModalForm(engine);

  // Coordinator observes the same stream (and forwards to the CLI's onEvent).
  const coordinator = new EventCoordinator();
  const unsubscribe: Unsubscribe = engine.subscribe((event) => {
    coordinator.observe(event);
    options.onEvent?.(event);
  });

  try {
    // idle -> form. (start_run is the only directly-dispatched command — it is the
    // harness starting the run, NOT a raw Pi/git command the user typed.)
    const formRequested = coordinator.next(["form_requested", "run_failed"]);
    await engine.dispatch({ type: "start_run", cwd: options.cwd });
    const formEvent = await formRequested;

    if (formEvent.type === "form_requested") {
      // Seed every collected field THROUGH the modal-form controller, then submit.
      const fieldNames = new Set(formEvent.schema.fields);
      for (const name of ORIGINATE_FIELDS) {
        if (fieldNames.has(name)) {
          modal.form.setValue(name, options.values[name] ?? "");
        }
      }

      const decisionRequested = coordinator.next(["decision_requested", "run_failed"]);
      await modal.form.submitForm();
      const decisionEvent = await decisionRequested;

      if (decisionEvent.type === "decision_requested") {
        // Choose + submit the decision THROUGH the controller (no raw command).
        const settled = coordinator.next(["run_completed", "run_failed"]);
        await modal.form.chooseDecision(decision);
        const final = await settled;

        if (final.type === "run_completed") {
          // Persist the human's decision to memory (decision-memory primitive).
          appendDecision(memory.pi, {
            id: `${ORIGINATE_PHASE}-${now()}`,
            phase: ORIGINATE_PHASE,
            decision,
            at: now(),
          });
        }
      }
    }

    const events = coordinator.events;
    const completedEvent = events.find((event) => event.type === "run_completed");
    const failedEvent = events.find((event) => event.type === "run_failed");

    return {
      cwd: options.cwd,
      events,
      completion:
        completedEvent?.type === "run_completed"
          ? { artifacts: completedEvent.artifacts, decisions: completedEvent.decisions }
          : undefined,
      failure:
        failedEvent?.type === "run_failed"
          ? { class: failedEvent.class, detail: failedEvent.detail }
          : undefined,
      decisions: recallDecisions(sessionManager),
      sessionManager,
      view: app.view,
      form: modal.form,
    };
  } finally {
    unsubscribe();
    app.unsubscribe();
    modal.unsubscribe();
    await memory.dispose();
  }
}

// ---------------------------------------------------------------------------
// Live TTY mount: ModalFormView beside AgentRunView under ONE shared TUI.
// ---------------------------------------------------------------------------

/** A live originate mount: both views under one TUI, plus teardown. */
export interface MountedOriginate {
  readonly tui: TUI;
  readonly agentView: AgentRunView;
  readonly form: ModalForm;
  readonly formView: ModalFormView;
  readonly unsubscribe: Unsubscribe;
  /** Unsubscribe from the engine and stop the TUI render loop. */
  stop(): void;
}

/**
 * Mount the live originate surface: the shell's {@link AgentRunView} (phase +
 * streaming progress) and the {@link ModalFormView} (the signature modal form)
 * composed as children of ONE shared pi-tui {@link TUI}. This is the ONLY path
 * that touches a real TTY (`ProcessTerminal` raw mode); requires
 * `process.stdout.isTTY`. The headless logic lives in {@link runOriginate}.
 */
export function mountOriginate(engine: EngineSeam): MountedOriginate {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const agentView = new AgentRunView();
  const form = new ModalForm((command) => engine.dispatch(command));
  const formView = new ModalFormView(form, tui);

  tui.addChild(agentView);
  tui.addChild(formView);

  const unsubscribe = engine.subscribe((event) => {
    agentView.handle(event);
    form.handle(event);
    formView.refresh();
    const focus = formView.fieldWidgets[0]?.widget ?? formView.decisionWidget;
    if (focus) {
      tui.setFocus(focus);
    }
    tui.requestRender();
  });

  tui.start();
  tui.requestRender();

  return {
    tui,
    agentView,
    form,
    formView,
    unsubscribe,
    stop(): void {
      unsubscribe();
      tui.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// CLI: `sibyl --version` / `originate` / `decisions ls`.
// ---------------------------------------------------------------------------

/** Sink for CLI output (overridable in tests). */
export interface CliIO {
  out(line: string): void;
  err(line: string): void;
}

const defaultIO: CliIO = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

const USAGE = [
  "sibyl — the SIBYL originate harness",
  "",
  "Usage:",
  "  sibyl --version",
  "  sibyl originate --product <p> --problem <q> --vision <v> [--yes] [--cwd <dir>] [--message <m>]",
  "  sibyl decisions ls [--cwd <dir>]",
].join("\n");

interface ParsedFlags {
  readonly flags: Record<string, string>;
  readonly bools: Set<string>;
  readonly positional: string[];
}

/** Parse `--flag value`, `--flag=value`, and bare `--bool` from argv. */
function parseFlags(args: readonly string[]): ParsedFlags {
  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[body] = next;
        i++;
      } else {
        bools.add(body);
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, bools, positional };
}

/** Ensure a git identity exists so the commit step does not fail in CI/temp dirs. */
function ensureGitIdentity(): void {
  const defaults: Record<string, string> = {
    GIT_AUTHOR_NAME: "SIBYL Harness",
    GIT_AUTHOR_EMAIL: "sibyl@harness.local",
    GIT_COMMITTER_NAME: "SIBYL Harness",
    GIT_COMMITTER_EMAIL: "sibyl@harness.local",
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

async function cliOriginate(parsed: ParsedFlags, io: CliIO): Promise<number> {
  const values: Record<string, string> = {
    product: parsed.flags.product ?? "",
    problem: parsed.flags.problem ?? "",
    vision: parsed.flags.vision ?? "",
  };
  const missing = ORIGINATE_FIELDS.filter((name) => values[name]?.trim().length === 0);
  if (missing.length > 0) {
    io.err(`originate: missing required values: ${missing.map((m) => `--${m}`).join(", ")}`);
    io.err(USAGE);
    return 2;
  }

  const cwd = parsed.flags.cwd ?? process.cwd();
  ensureGitIdentity();

  io.out(`sibyl: originating in ${cwd}`);

  const result = await runOriginate({
    cwd,
    values,
    decision: COMMIT_CHOICE,
    commitMessage: parsed.flags.message,
    onEvent: (event) => {
      switch (event.type) {
        case "phase_changed":
          io.out(`phase: ${event.phase}`);
          break;
        case "progress":
          io.out(`progress: [${event.kind}] ${event.detail.replace(/\n/g, " ").trim()}`);
          break;
        case "form_requested":
          io.out(`form: ${event.schema.fields.join(", ")}`);
          break;
        case "decision_requested":
          io.out(`decision: ${event.prompt} [${event.options.join(" / ")}] -> ${COMMIT_CHOICE}`);
          break;
        case "run_completed":
          io.out(
            `completed: ${event.artifacts.join(", ") || "none"} (${event.decisions} decision)`,
          );
          break;
        case "run_failed":
          io.err(`failed: ${event.class}: ${event.detail}`);
          break;
        default:
          break;
      }
    },
  });

  if (result.failure || !result.completion) {
    io.err(`originate failed: ${result.failure?.detail ?? "run did not complete"}`);
    return 1;
  }

  // Mirror the recalled decision log to disk so `decisions ls` can read it back
  // across process invocations (the in-process store is per-run).
  await mkdir(join(cwd, ".sibyl"), { recursive: true });
  await writeFile(
    join(cwd, DECISIONS_MIRROR),
    `${JSON.stringify(result.decisions, null, 2)}\n`,
    "utf8",
  );

  io.out(`artifacts: ${result.completion.artifacts.join(", ")}`);
  io.out(`decisions: ${result.decisions.length}`);
  for (const entry of result.decisions) {
    io.out(`  - [${entry.phase}] ${entry.decision} (${entry.id})`);
  }
  return 0;
}

async function cliDecisionsLs(parsed: ParsedFlags, io: CliIO): Promise<number> {
  const cwd = parsed.flags.cwd ?? process.cwd();
  let raw: string;
  try {
    raw = await readFile(join(cwd, DECISIONS_MIRROR), "utf8");
  } catch {
    io.out("decisions: 0");
    return 0;
  }
  const entries = JSON.parse(raw) as DecisionEntry[];
  io.out(`decisions: ${entries.length}`);
  for (const entry of entries) {
    io.out(`  - [${entry.phase}] ${entry.decision} (${entry.id})`);
  }
  return 0;
}

/**
 * The CLI dispatcher backing the `sibyl` bin. Returns the process exit code.
 * `--version` prints `sibyl <semver>`; `originate` runs the non-interactive
 * walking skeleton; `decisions ls` reads the decision log mirror.
 */
export async function runCli(argv: readonly string[], io: CliIO = defaultIO): Promise<number> {
  const parsed = parseFlags(argv);
  const command = parsed.positional[0];

  if (parsed.bools.has("version") || parsed.bools.has("v") || command === "version") {
    io.out(`sibyl ${SIBYL_VERSION}`);
    return 0;
  }

  if (
    parsed.bools.has("help") ||
    parsed.bools.has("h") ||
    command === undefined ||
    command === "help"
  ) {
    io.out(USAGE);
    return command === undefined ? 1 : 0;
  }

  switch (command) {
    case "originate":
      return cliOriginate(parsed, io);
    case "decisions":
      if (parsed.positional[1] === "ls" || parsed.positional[1] === undefined) {
        return cliDecisionsLs(parsed, io);
      }
      io.err(`unknown decisions subcommand: ${parsed.positional[1]}`);
      return 2;
    default:
      io.err(`unknown command: ${command}`);
      io.err(USAGE);
      return 2;
  }
}

export type { OriginateConnect, OriginateSession };
export { progressOf };
