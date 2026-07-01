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

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { createSibylEngineExtension } from "./extension";
import { bootSession } from "./session";
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
].join(" ");

/** Tool names whose completion likely changed an on-disk artifact (→ re-read). */
function isArtifactWritingTool(name: string): boolean {
  return /^(write|edit|multi_edit|apply_patch|create|git)/i.test(name);
}

/** A short human detail for a tool call (the target path, if any). */
function toolDetail(args: unknown): string {
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    for (const key of ["path", "file", "file_path", "filename"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// The live default connect: a real Codex-backed session.
// ---------------------------------------------------------------------------

/**
 * The production connector: boots a real Pi `AgentSession` via {@link bootSession}
 * with the git tool bound and the guided cockpit brief appended to the system
 * prompt. Auth + model come from the user's `~/.pi/agent` config (the
 * `openai-codex` login + `defaultModel`). Requires no login step when already
 * authenticated.
 */
export const defaultConversationConnect: ConversationConnect = async (cwd) => {
  const { session } = await bootSession(cwd, {
    extensionFactories: [createSibylEngineExtension(), (pi) => registerGitTool(pi)],
    appendSystemPrompt: [COCKPIT_GUIDE],
  });
  return session;
};

// ---------------------------------------------------------------------------
// The adapter: Pi AgentSessionEvent -> ConversationEvent.
// ---------------------------------------------------------------------------

/** Options for {@link createConversation}. */
export interface CreateConversationOptions {
  /** The working directory the agent builds the project in. */
  cwd: string;
  /** Override the session connector. Default: {@link defaultConversationConnect}. */
  connect?: ConversationConnect;
}

class ConversationImpl implements Conversation {
  readonly #cwd: string;
  readonly #connect: ConversationConnect;
  readonly #listeners = new Set<(event: ConversationEvent) => void>();
  readonly #abort = new AbortController();

  #session: ConversationSession | undefined;
  #connecting: Promise<ConversationSession> | undefined;
  #unsubscribeSession: (() => void) | undefined;
  #streaming = false;
  /** Detail (target path) captured at `tool_execution_start`, reused on `_end`. */
  readonly #toolDetails = new Map<string, string>();

  constructor(options: CreateConversationOptions) {
    this.#cwd = options.cwd;
    this.#connect = options.connect ?? defaultConversationConnect;
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
        this.#emit({ type: "tool", name: event.toolName, phase: "start", detail });
        break;
      }
      case "tool_execution_end": {
        const detail = this.#toolDetails.get(event.toolCallId) ?? "";
        this.#toolDetails.delete(event.toolCallId);
        this.#emit({
          type: "tool",
          name: event.toolName,
          phase: "end",
          detail,
          isError: event.isError === true,
        });
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
