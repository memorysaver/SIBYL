/**
 * Conversation seam (SIBYL cockpit) — the engine↔renderer contract for a live,
 * multi-turn AGENT CONVERSATION (the cockpit's chat), distinct from the
 * form→decision {@link ./seam} used by the modal-form originate.
 *
 * This is the ENGINE side: it MAY import the Pi SDK (it adapts the real
 * `AgentSession`). The renderer consumes only {@link ConversationEvent} /
 * {@link ConversationCommand} — never the SDK — mirroring ADR-001.
 *
 * {@link createConversation} boots a real Codex-backed `AgentSession` (via
 * {@link bootPhaseSession}, using the user's existing `~/.pi/agent` login +
 * default model) FOR THE PHASE THE PROJECT'S ARTIFACTS ARE IN (SIBYL-016): the
 * cockpit routes through the AEP kernel's `detectPhase` over a real fs/git
 * probe, so a repo with no committed README boots the originate session and a
 * repo with a committed README (but no `product/index.yaml`) boots the ENVISION
 * session — envision brief compiled in, `submit_envision` registered, guard on.
 * Beyond-registry artifact states (post-envision phases arrive at L2) fall back
 * to envision with a status note rather than crashing the cockpit.
 *
 * The booted session's tools are gated to the phase's allowlist, and the Pi
 * `AgentSessionEvent` stream is translated into the small
 * {@link ConversationEvent} union the cockpit renders. A scripted session double
 * satisfies the same {@link ConversationSession} port, so the mapping is
 * unit-testable with NO live model.
 */

import type {
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import { createSibylEngineExtension } from "./extension";
import {
  COCKPIT_ORIGINATE_POINTER,
  COCKPIT_TOOLS,
  bootPhaseSession,
  createFsArtifactProbe,
  detectPhase,
  getPhaseSpec,
  type PhaseSpec,
} from "./flow";
import { SUBMIT_ENVISION_TOOL_NAME, type PhaseCompletionHooks } from "./submit";
import { appendDecision, type DecisionEntry } from "../memory/decisions";
import { registerGitTool } from "../tools/git";

// The cockpit's tool gate and originate role line are owned by the AEP phase
// registry (flow.ts) — the kernel fixes WHAT the model may touch and how each
// phase orients. Re-exported here so the seam's consumers keep one import site.
export { COCKPIT_ORIGINATE_POINTER, COCKPIT_TOOLS };

// ---------------------------------------------------------------------------
// The protocol: ConversationEvent (engine -> renderer) + ConversationCommand.
// ---------------------------------------------------------------------------

/** The cockpit tabs an artifact change can invalidate (v1: only the Goal/README). */
export type ArtifactTab = "goal" | "story-map" | "architecture" | "decisions";

/** Events the conversation streams to the cockpit. Discriminated on `type`. */
export type ConversationEvent =
  | {
      /**
       * The AEP phase this cockpit conversation is conducting (SIBYL-016).
       * Replayed to every subscriber on subscribe — detection is a pure
       * artifact read, so it costs no model call and arrives before any send.
       * `note` carries the beyond-registry fallback explanation, when any.
       */
      readonly type: "phase";
      readonly phase: string;
      readonly note?: string;
    }
  | { readonly type: "user_echo"; readonly text: string }
  | { readonly type: "assistant_delta"; readonly text: string }
  | { readonly type: "assistant_done" }
  | {
      readonly type: "tool";
      readonly name: string;
      readonly phase: "start" | "end";
      readonly detail: string;
      readonly isError?: boolean;
    }
  | { readonly type: "artifact_changed"; readonly tab: ArtifactTab }
  | { readonly type: "decision_captured"; readonly entry: DecisionEntry }
  | { readonly type: "status"; readonly state: "idle" | "streaming" }
  | { readonly type: "error"; readonly detail: string };

/** Commands the cockpit dispatches into the conversation. */
export type ConversationCommand =
  | { readonly type: "send"; readonly text: string }
  | { readonly type: "abort" };

/**
 * The narrow slice of the Pi `AgentSession` the conversation needs — the real
 * session satisfies it structurally, and a scripted double implements it for
 * tests (mirrors `OriginateSession`).
 */
export interface ConversationSession {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  setActiveToolsByName(toolNames: string[]): void;
  prompt(text: string): Promise<void>;
  followUp?(text: string): Promise<void>;
  abort?(): Promise<void> | void;
  dispose(): void | Promise<void>;
}

/** Opens a {@link ConversationSession} for `cwd`. The seam's SDK injection point. */
export type ConversationConnect = (
  cwd: string,
  signal: AbortSignal,
) => Promise<ConversationSession>;

/** A live conversation: subscribe to its events, dispatch commands, dispose. */
export interface Conversation {
  subscribe(listener: (event: ConversationEvent) => void): () => void;
  dispatch(command: ConversationCommand): Promise<void>;
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Detect-state phase routing (SIBYL-016).
// ---------------------------------------------------------------------------

/** The cockpit's resolved AEP phase: the registry spec + an optional status note. */
export interface CockpitPhase {
  /** The phase registry entry the cockpit session boots with. */
  readonly spec: PhaseSpec;
  /** A human-readable status note (set only on the beyond-registry fallback). */
  readonly note?: string;
}

/**
 * The status note surfaced when the project's artifacts are beyond every
 * registered phase (committed README AND `product/index.yaml` both present):
 * `detectPhase` THROWS there by design, and for L1 the cockpit falls back to
 * the envision phase instead of crashing (post-envision phases arrive at L2).
 */
export const COCKPIT_BEYOND_REGISTRY_NOTE =
  "Project artifacts are beyond the registered phases (README.md and product/index.yaml are both " +
  "present) — falling back to the envision phase. Post-envision phases arrive at L2.";

/**
 * Route the cockpit to its AEP phase from the project's artifacts alone
 * (detect-state routing, SIBYL-016): `detectPhase` over the real fs/git probe,
 * per the ratified Phase Pattern. When the artifacts are beyond the registry
 * (`detectPhase` throws), the cockpit must not crash — it falls back to the
 * LAST registered phase (envision) and carries {@link COCKPIT_BEYOND_REGISTRY_NOTE}
 * so the UI can say why.
 */
export function resolveCockpitPhase(cwd: string): CockpitPhase {
  const probe = createFsArtifactProbe(cwd);
  try {
    return { spec: getPhaseSpec(detectPhase(probe)) };
  } catch {
    return { spec: getPhaseSpec("envision"), note: COCKPIT_BEYOND_REGISTRY_NOTE };
  }
}

// ---------------------------------------------------------------------------
// Tool gating + compiled originate brief.
// ---------------------------------------------------------------------------

/** The run phase a cockpit git-commit decision is recorded under (SIBYL-011). */
const COCKPIT_PHASE = "originate";

/** Tool names whose completion likely changed an on-disk artifact (→ re-read). */
function isArtifactWritingTool(name: string): boolean {
  return /^(write|edit|multi_edit|apply_patch|create|git)/i.test(name);
}

/** A short human detail for a tool call (the target path, or the git subcommand). */
function toolDetail(args: unknown): string {
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    for (const key of ["path", "file", "file_path", "filename"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
    // The git tool has no path; surface its subcommand so chat shows `git commit`.
    if (typeof record.subcommand === "string" && record.subcommand.length > 0) {
      return record.subcommand;
    }
  }
  return "";
}

/** The git tool's `{subcommand, args}` recovered from a `tool_execution_start` args blob. */
interface GitOp {
  readonly subcommand: string;
  readonly args: readonly string[];
}

/** Parse the narrow git tool's `{subcommand, args}` off a start-event args blob (or `undefined`). */
function parseGitOp(args: unknown): GitOp | undefined {
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    if (typeof record.subcommand === "string") {
      const list = Array.isArray(record.args)
        ? record.args.filter((value): value is string => typeof value === "string")
        : [];
      return { subcommand: record.subcommand, args: list };
    }
  }
  return undefined;
}

/** Pull the `-m` / `--message` value out of a `git commit`'s args, if present. */
function commitMessageOf(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if ((arg === "-m" || arg === "--message") && i + 1 < args.length) {
      return args[i + 1];
    }
    if (arg.startsWith("-m") && arg.length > 2) {
      return arg.slice(2);
    }
    if (arg.startsWith("--message=")) {
      return arg.slice("--message=".length);
    }
  }
  return undefined;
}

/** A human decision string for a README commit (e.g. `Committed README.md — "docs: …"`). */
function describeCommit(args: readonly string[]): string {
  const message = commitMessageOf(args);
  return message ? `Committed README.md — "${message}"` : "Committed README.md";
}

/** Sink for a decision the agent makes mid-conversation (default: persist via `appendDecision`). */
export type DecisionSink = (entry: DecisionEntry) => void;

/**
 * Wire a phase's {@link PhaseCompletionHooks} into the conversation seam
 * (SIBYL-016): when the phase's typed submit tool (e.g. `submit_envision`)
 * completes, route the completion decision through the EXISTING SIBYL-011
 * decision-capture path — persist via `capture`, surface a `decision_captured`
 * event, and invalidate the Decisions tab — and re-render the Architecture tab
 * (`artifact_changed`) so the freshly committed `product/index.yaml` shows up
 * without a restart. Exported as a pure factory so the wiring is unit-testable
 * without a live model.
 */
export function createCockpitCompletionHooks(deps: {
  /** Persist the completion {@link DecisionEntry} (default sink: `appendDecision`). */
  capture: DecisionSink;
  /** Emit a {@link ConversationEvent} to the cockpit. */
  emit: (event: ConversationEvent) => void;
  /** Timestamp source threaded into the submit tool (deterministic in tests). */
  now?: () => number;
}): PhaseCompletionHooks {
  return {
    ...(deps.now ? { now: deps.now } : {}),
    onPhaseCompleted: () => {
      deps.emit({ type: "artifact_changed", tab: "architecture" });
    },
    decisionSink: (entry) => {
      deps.capture(entry);
      deps.emit({ type: "decision_captured", entry });
      deps.emit({ type: "artifact_changed", tab: "decisions" });
    },
  };
}

// ---------------------------------------------------------------------------
// The live default connect: a real Codex-backed session.
// ---------------------------------------------------------------------------

/**
 * Boot a real Codex-backed cockpit session FOR ONE AEP PHASE via the kernel's
 * {@link bootPhaseSession} (SIBYL-016): SIBYL_PERSONA → the phase role line →
 * the phase's COMPILED SKILL.md body (SIBYL-017), skills narrowed to exactly
 * the phase skill, tools narrowed to the phase allowlist, the invariant guard
 * bound, and — when the registry entry declares one — the phase's typed
 * completion tool (e.g. `submit_envision`) registered with the caller's
 * `completion` hooks. The skill file stays the authoring unit, but the model
 * never has to notice or read it: injection, not discovery, delivers the flow.
 * Auth + model come from the user's `~/.pi/agent` config. `onPi`, when
 * supplied, receives the session's real `ExtensionAPI` so the default decision
 * sink can persist via `appendDecision` (the same pi-capture trick `main.ts`
 * uses).
 */
async function bootCockpitSession(
  cwd: string,
  phase: CockpitPhase,
  onPi?: (pi: ExtensionAPI) => void,
  completion?: PhaseCompletionHooks,
): Promise<ConversationSession> {
  const extensionFactories: ExtensionFactory[] = [
    createSibylEngineExtension(),
    (pi) => registerGitTool(pi),
  ];
  if (onPi) {
    extensionFactories.push((pi) => {
      onPi(pi);
    });
  }
  const { session } = await bootPhaseSession(phase.spec, {
    cwd,
    extensionFactories,
    ...(completion ? { completion } : {}),
  });
  return session;
}

/**
 * The production connector: detect-state routes the project (`README.md`
 * committed? `product/index.yaml` present?) and boots the matching phase
 * session — originate exactly as before SIBYL-016; envision (brief +
 * `submit_envision` + guard) for a committed README — via
 * {@link bootCockpitSession}. Auth + model come from the user's `~/.pi/agent`
 * config (the `openai-codex` login + `defaultModel`). Requires no login step
 * when already authenticated.
 */
export const defaultConversationConnect: ConversationConnect = (cwd) =>
  bootCockpitSession(cwd, resolveCockpitPhase(cwd));

// ---------------------------------------------------------------------------
// The adapter: Pi AgentSessionEvent -> ConversationEvent.
// ---------------------------------------------------------------------------

/** Options for {@link createConversation}. */
export interface CreateConversationOptions {
  /** The working directory the agent builds the project in. */
  cwd: string;
  /** Override the session connector. Default: {@link defaultConversationConnect}. */
  connect?: ConversationConnect;
  /**
   * Sink for a decision the agent makes mid-conversation (currently: a README
   * `git commit`). Default: persist via {@link appendDecision} to the
   * `ExtensionAPI` of the booted session (captured while connecting). Tests inject
   * a spy so the headless run needs no real `ExtensionAPI`.
   */
  captureDecision?: DecisionSink;
  /** Timestamp source for captured decisions (deterministic in tests). Default: `Date.now`. */
  now?: () => number;
}

class ConversationImpl implements Conversation {
  readonly #cwd: string;
  readonly #connect: ConversationConnect;
  readonly #captureDecision: DecisionSink;
  readonly #now: () => number;
  readonly #listeners = new Set<(event: ConversationEvent) => void>();
  readonly #abort = new AbortController();
  /**
   * The AEP phase this conversation conducts, detect-state routed from the
   * project's artifacts at construction (SIBYL-016). A pure fs/git read — no
   * session, no model call — so the lazy-connect contract is untouched.
   */
  readonly #phase: CockpitPhase;

  #session: ConversationSession | undefined;
  #connecting: Promise<ConversationSession> | undefined;
  #unsubscribeSession: (() => void) | undefined;
  #streaming = false;
  /** The booted session's real `ExtensionAPI`, captured when the default connect runs. */
  #capturedPi: ExtensionAPI | undefined;
  /** Detail (target path / git subcommand) captured at `tool_execution_start`, reused on `_end`. */
  readonly #toolDetails = new Map<string, string>();
  /** Git op captured at `tool_execution_start`, read back at `_end` to detect a commit. */
  readonly #gitOps = new Map<string, GitOp>();

  constructor(options: CreateConversationOptions) {
    this.#cwd = options.cwd;
    this.#now = options.now ?? Date.now;
    this.#phase = resolveCockpitPhase(options.cwd);
    // Default connect captures `pi` into this instance so the default sink can
    // persist commits through the genuine `pi.appendEntry` path, and threads the
    // phase's completion hooks so a typed submit surfaces on the tabs.
    this.#connect =
      options.connect ??
      ((cwd) =>
        bootCockpitSession(
          cwd,
          this.#phase,
          (pi) => {
            this.#capturedPi = pi;
          },
          this.#completionHooks(),
        ));
    this.#captureDecision =
      options.captureDecision ??
      ((entry) => {
        if (this.#capturedPi) {
          appendDecision(this.#capturedPi, entry);
        }
      });
  }

  subscribe(listener: (event: ConversationEvent) => void): () => void {
    this.#listeners.add(listener);
    // Replay the resolved phase to the new subscriber (deferred so a subscriber
    // is never re-entered while its own `subscribe` call is still on the stack).
    // This is how the cockpit learns the phase before any send — free of model
    // cost, so zero-quota render smokes still see it.
    queueMicrotask(() => {
      if (this.#listeners.has(listener)) {
        const note = this.#phase.note;
        listener({
          type: "phase",
          phase: this.#phase.spec.id,
          ...(note !== undefined ? { note } : {}),
        });
      }
    });
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * The phase's completion hooks (only for phases declaring a typed completion
   * tool): persist the decision through this conversation's sink and surface
   * `decision_captured` + `artifact_changed` events (SIBYL-016).
   */
  #completionHooks(): PhaseCompletionHooks | undefined {
    if (!this.#phase.spec.completionToolFactory) {
      return undefined;
    }
    return createCockpitCompletionHooks({
      capture: (entry) => {
        this.#captureDecision(entry);
      },
      emit: (event) => {
        this.#emit(event);
      },
      now: this.#now,
    });
  }

  async dispatch(command: ConversationCommand): Promise<void> {
    if (command.type === "abort") {
      await this.#session?.abort?.();
      return;
    }

    // Echo the user's message immediately — before the (possibly slow) first
    // connect — so it appears the instant they hit Enter.
    this.#emit({ type: "user_echo", text: command.text });

    let session: ConversationSession;
    try {
      session = await this.#ensureSession();
    } catch (error) {
      this.#emit({ type: "error", detail: describeError(error) });
      this.#emit({ type: "status", state: "idle" });
      return;
    }

    try {
      if (this.#streaming && session.followUp) {
        await session.followUp(command.text);
      } else {
        await session.prompt(command.text);
      }
    } catch (error) {
      this.#emit({ type: "error", detail: describeError(error) });
      this.#emit({ type: "status", state: "idle" });
    }
  }

  async dispose(): Promise<void> {
    this.#abort.abort();
    this.#unsubscribeSession?.();
    await this.#session?.dispose();
    this.#session = undefined;
    this.#listeners.clear();
  }

  #ensureSession(): Promise<ConversationSession> {
    if (this.#session) {
      return Promise.resolve(this.#session);
    }
    if (!this.#connecting) {
      this.#connecting = (async () => {
        const session = await this.#connect(this.#cwd, this.#abort.signal);
        this.#unsubscribeSession = session.subscribe((event) => {
          this.#onAgentEvent(event);
        });
        // Gate tools to the DETECTED phase's allowlist (SIBYL-016): the cockpit
        // set for originate, read-only + `submit_envision` for envision.
        session.setActiveToolsByName([...this.#phase.spec.toolAllowlist]);
        this.#session = session;
        return session;
      })();
    }
    return this.#connecting;
  }

  /** Translate one Pi `AgentSessionEvent` into cockpit {@link ConversationEvent}s. */
  #onAgentEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        this.#streaming = true;
        this.#emit({ type: "status", state: "streaming" });
        break;
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          this.#emit({ type: "assistant_delta", text: event.assistantMessageEvent.delta });
        }
        break;
      case "tool_execution_start": {
        const detail = toolDetail(event.args);
        this.#toolDetails.set(event.toolCallId, detail);
        // `tool_execution_end` carries NO args, so stash the git op here to detect
        // a commit when it completes (mirrors the `#toolDetails` stash pattern).
        if (event.toolName === "git") {
          const gitOp = parseGitOp(event.args);
          if (gitOp) {
            this.#gitOps.set(event.toolCallId, gitOp);
          }
        }
        this.#emit({ type: "tool", name: event.toolName, phase: "start", detail });
        break;
      }
      case "tool_execution_end": {
        const detail = this.#toolDetails.get(event.toolCallId) ?? "";
        this.#toolDetails.delete(event.toolCallId);
        const gitOp = this.#gitOps.get(event.toolCallId);
        this.#gitOps.delete(event.toolCallId);
        this.#emit({
          type: "tool",
          name: event.toolName,
          phase: "end",
          detail,
          isError: event.isError === true,
        });
        // A successful `git commit` is a captured DECISION: the user directed the
        // agent to persist the README, and it did. Record it to decision-memory and
        // surface it on the Decisions tab — the user typed no raw git command (SIBYL-011).
        if (gitOp?.subcommand === "commit" && event.isError !== true) {
          this.#captureCommitDecision(gitOp.args);
        }
        if (isArtifactWritingTool(event.toolName)) {
          this.#emit({ type: "artifact_changed", tab: "goal" });
        }
        // A successful `submit_envision` means the harness just wrote+committed
        // `product/index.yaml` — invalidate the Architecture tab (SIBYL-016).
        // (The decision itself is captured by the completion hooks, not here.)
        if (event.toolName === SUBMIT_ENVISION_TOOL_NAME && event.isError !== true) {
          this.#emit({ type: "artifact_changed", tab: "architecture" });
        }
        break;
      }
      case "agent_end":
        this.#streaming = false;
        this.#emit({ type: "assistant_done" });
        this.#emit({ type: "artifact_changed", tab: "goal" });
        this.#emit({ type: "status", state: "idle" });
        break;
      default:
        break;
    }
  }

  /** Persist a README-commit decision to memory and surface it on the Decisions tab. */
  #captureCommitDecision(commitArgs: readonly string[]): void {
    const at = this.#now();
    const entry: DecisionEntry = {
      id: `${COCKPIT_PHASE}-${at}`,
      phase: COCKPIT_PHASE,
      decision: describeCommit(commitArgs),
      at,
    };
    this.#captureDecision(entry);
    this.#emit({ type: "decision_captured", entry });
    this.#emit({ type: "artifact_changed", tab: "decisions" });
  }

  #emit(event: ConversationEvent): void {
    for (const listener of Array.from(this.#listeners)) {
      listener(event);
    }
  }
}

/**
 * Create a {@link Conversation} that boots a real (or injected) agent session on
 * the first `send`, gates its tools, and streams translated events. The renderer
 * subscribes to it and dispatches `send` / `abort`.
 */
export function createConversation(options: CreateConversationOptions): Conversation {
  return new ConversationImpl(options);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
