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
 * {@link bootSession}, using the user's existing `~/.pi/agent` login + default
 * model), gates its tools, injects a guided system prompt, and translates the Pi
 * `AgentSessionEvent` stream into the small {@link ConversationEvent} union the
 * cockpit renders. A scripted session double satisfies the same
 * {@link ConversationSession} port, so the mapping is unit-testable with NO live
 * model.
 */

import type {
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import { createSibylEngineExtension } from "./extension";
import { bootSession } from "./session";
import { appendDecision, type DecisionEntry } from "../memory/decisions";
import { registerGitTool } from "../tools/git";

// ---------------------------------------------------------------------------
// The protocol: ConversationEvent (engine -> renderer) + ConversationCommand.
// ---------------------------------------------------------------------------

/** The cockpit tabs an artifact change can invalidate (v1: only the Goal/README). */
export type ArtifactTab = "goal" | "story-map" | "architecture" | "decisions";

/** Events the conversation streams to the cockpit. Discriminated on `type`. */
export type ConversationEvent =
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
// Tool gating + guided system prompt.
// ---------------------------------------------------------------------------

/**
 * Tools the cockpit agent may use: read-only discovery, real file authoring
 * (so the Goal/README the user sees is genuinely agent-built), and git.
 */
export const COCKPIT_TOOLS = ["read", "grep", "find", "ls", "write", "edit", "git"] as const;

/** The guided-flow brief appended to the system prompt (the co-pilot's role). */
export const COCKPIT_GUIDE = [
  "You are SIBYL's originate co-pilot, driving a project cockpit whose primary view is the project's README (its Goal).",
  "Converse with the user to understand the PRODUCT they want to build, the PROBLEM it solves, and the VISION.",
  "Ask one focused question at a time — keep it a natural dialogue, never a rigid form.",
  "As the intent becomes clear, WRITE and iteratively refine `README.md` in the working directory using your tools:",
  "a clear title, a one-line pitch, a `## Problem` section, and a `## Vision` section. Revise it as you learn more.",
  "When the README reflects the user's intent, offer to commit it with git.",
  "When the user asks you to commit (or approves committing), persist `README.md` YOURSELF with the `git` tool —",
  "never ask the user to run a raw git command. First `git init` if the working directory is not yet a repo,",
  "then `git add README.md`, then `git commit -m \"docs: add project README\"` (or a message reflecting the change).",
  "Always pass the working directory as the tool's `cwd`.",
].join(" ");

/** The run phase decisions captured in the cockpit are recorded under (mirrors main.ts). */
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

// ---------------------------------------------------------------------------
// The live default connect: a real Codex-backed session.
// ---------------------------------------------------------------------------

/**
 * Boot a real Codex-backed cockpit session: the SIBYL engine-extension + the
 * narrow git tool bound, the guided cockpit brief appended to the system prompt.
 * Auth + model come from the user's `~/.pi/agent` config. `onPi`, when supplied,
 * receives the session's real `ExtensionAPI` so the default decision sink can
 * persist commits via `appendDecision` (the same pi-capture trick `main.ts` uses).
 */
async function bootCockpitSession(
  cwd: string,
  onPi?: (pi: ExtensionAPI) => void,
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
  const { session } = await bootSession(cwd, {
    extensionFactories,
    appendSystemPrompt: [COCKPIT_GUIDE],
  });
  return session;
}

/**
 * The production connector: boots a real Pi `AgentSession` via {@link bootSession}
 * with the git tool bound and the guided cockpit brief appended to the system
 * prompt. Auth + model come from the user's `~/.pi/agent` config (the
 * `openai-codex` login + `defaultModel`). Requires no login step when already
 * authenticated.
 */
export const defaultConversationConnect: ConversationConnect = (cwd) => bootCockpitSession(cwd);

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
    // Default connect captures `pi` into this instance so the default sink can
    // persist commits through the genuine `pi.appendEntry` path.
    this.#connect =
      options.connect ??
      ((cwd) =>
        bootCockpitSession(cwd, (pi) => {
          this.#capturedPi = pi;
        }));
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
    return () => {
      this.#listeners.delete(listener);
    };
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
        session.setActiveToolsByName([...COCKPIT_TOOLS]);
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
