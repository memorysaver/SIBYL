/**
 * SIBYL-003: the originate {@link EngineRunCore} — drives a Pi agent through a
 * guided "imagine -> README" pass and maps its event stream onto the engine seam.
 *
 * This is the real implementation that plugs into `createEngine(core)` (SIBYL-002):
 *
 *   - `startForm`     idle -> form: requests the originate form (product/problem/vision).
 *   - `runToDecision` form -> running -> decision: prompts the Pi agent (seeded with
 *      the form values) for an imagine pass with tools gated to **read-only + git**,
 *      maps Pi `tool_execution_*` / `message_update` events to `progress` events, and
 *      — because the agent's write tools are gated off — the ENGINE writes `README.md`
 *      in the cwd from the agent's streamed output, then requests the commit decision.
 *   - `complete`      decision -> done: on "Commit", `git init` + `add` + `commit` the
 *      draft via the narrow git tool (SIBYL-004 `runGit`), then reports completion.
 *
 * It touches NEITHER `seam.ts` NOR `state-machine.ts`: phase transitions and the
 * lifecycle events (`form_requested`, `decision_requested`, `run_completed`,
 * `run_failed`) are owned by the engine. The core speaks only through its return
 * values and `ctx.emitProgress`.
 *
 * The Pi `AgentSession` is reached through a narrow {@link OriginateSession} port so
 * the agent-driven core can be exercised by a scripted test double that emits the
 * REAL Pi `AgentSessionEvent` shapes (no live model in CI). The production
 * {@link defaultConnect} boots a session via `bootSession` with the git tool bound.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { registerGitTool, runGit } from "../tools/git";
import { createSibylEngineExtension } from "./extension";
import {
  RunFailure,
  type CompleteContext,
  type DecisionRequest,
  type EngineRunCore,
  type FormSchema,
  type RunCompletion,
  type RunContext,
} from "./seam";
import { bootSession } from "./session";

// ---------------------------------------------------------------------------
// Constants (the originate contract — mirrored by the protocol_sequences).
// ---------------------------------------------------------------------------

/** The originate form fields the renderer collects (product-context: `originate-run`). */
export const ORIGINATE_FORM_FIELDS = ["product", "problem", "vision"] as const;

/** The Pi read-only tool names (verified against `createReadOnlyTools` @ 0.80.2). */
export const ORIGINATE_READONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

/** The narrow git tool name (SIBYL-004). */
export const ORIGINATE_GIT_TOOL = "git";

/**
 * The active-tool allowlist for the imagine pass: read-only + git. Notably this
 * EXCLUDES `write`/`edit`/`bash`, so the agent cannot write files — the engine
 * writes `README.md` from the agent's streamed output instead.
 */
export const ORIGINATE_ACTIVE_TOOLS = [...ORIGINATE_READONLY_TOOLS, ORIGINATE_GIT_TOOL] as const;

/** The artifact the originate run produces. */
export const README_FILENAME = "README.md";

/** The commit-gate decision requested when the imagine pass completes. */
export const COMMIT_DECISION = {
  prompt: "Commit this README?",
  options: ["Commit", "Revise", "Cancel"],
} as const;

/** The choice (case-insensitive) that triggers the git commit in `complete`. */
export const COMMIT_CHOICE = "Commit";

/** Default commit message for the originate README draft. */
const DEFAULT_COMMIT_MESSAGE = "docs: add originate README draft";

// ---------------------------------------------------------------------------
// The narrow session port + connector (the SDK injection point).
// ---------------------------------------------------------------------------

/**
 * The slice of the Pi `AgentSession` the originate core drives. The real
 * `AgentSession` satisfies this structurally; a scripted test double implements it
 * to emit real `AgentSessionEvent`s without a live model.
 */
export interface OriginateSession {
  /** Subscribe to the agent event stream; returns an unsubscribe. */
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  /** Gate the active tool set by name (read-only + git for the imagine pass). */
  setActiveToolsByName(toolNames: string[]): void;
  /** Send the imagine prompt; resolves when the agent run settles. */
  prompt(text: string): Promise<void>;
  /** Abort an in-flight run (best effort; optional on the port). */
  abort?(): Promise<void> | void;
  /** Release the session. */
  dispose(): void | Promise<void>;
}

/** Opens an {@link OriginateSession} for `cwd`. The seam injection point for the SDK. */
export type OriginateConnect = (cwd: string, signal: AbortSignal) => Promise<OriginateSession>;

/**
 * Production connector: boot a Pi `AgentSession` for `cwd` bound to the SIBYL
 * engine-extension AND the narrow git tool, so `git` is a real, gate-able tool
 * during the imagine pass.
 */
export const defaultConnect: OriginateConnect = async (cwd) => {
  const { session } = await bootSession(cwd, {
    extensionFactories: [createSibylEngineExtension(), (pi) => registerGitTool(pi)],
  });
  return session;
};

// ---------------------------------------------------------------------------
// Prompt + README composition.
// ---------------------------------------------------------------------------

function field(values: Readonly<Record<string, string>>, key: string): string {
  const value = values[key]?.trim();
  return value && value.length > 0 ? value : "(unspecified)";
}

/** Build the imagine-pass prompt, seeded with the submitted form values. */
export function buildImaginePrompt(values: Readonly<Record<string, string>>): string {
  return [
    "You are running an IMAGINE pass to originate a new project's README.",
    "If helpful, inspect the working directory with your read-only tools, then",
    "compose the COMPLETE Markdown body of a README.md for the project below.",
    "Output ONLY the README markdown — no preamble, no explanation, no code fences.",
    "Your file-writing tools are disabled; the SIBYL harness writes the file for you.",
    "",
    `Product: ${field(values, "product")}`,
    `Problem: ${field(values, "problem")}`,
    `Vision: ${field(values, "vision")}`,
  ].join("\n");
}

/** A deterministic README seed used only when the agent streams no text. */
function fallbackReadme(values: Readonly<Record<string, string>>): string {
  const title = values.product?.trim() || "New Project";
  return [
    `# ${title}`,
    "",
    "## Problem",
    "",
    field(values, "problem"),
    "",
    "## Vision",
    "",
    field(values, "vision"),
  ].join("\n");
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Progress mapping (Pi AgentEvent -> seam `progress` events).
// ---------------------------------------------------------------------------

/** Human-readable detail for a `tool_execution_*` event. */
function toolDetail(
  event: Extract<
    AgentSessionEvent,
    { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
  >,
): string {
  switch (event.type) {
    case "tool_execution_start":
      return `${event.toolName}: started`;
    case "tool_execution_update":
      return `${event.toolName}: working`;
    case "tool_execution_end":
      return `${event.toolName}: ${event.isError ? "failed" : "done"}`;
  }
}

// ---------------------------------------------------------------------------
// The originate run core.
// ---------------------------------------------------------------------------

/** Options for {@link createOriginateCore}. */
export interface OriginateCoreOptions {
  /** Override the session connector (tests inject a scripted double). */
  connect?: OriginateConnect;
  /** Commit message used by `complete` on a "Commit" decision. */
  commitMessage?: string;
}

async function runGitStep(subcommand: string, args: string[], cwd: string): Promise<void> {
  const result = await runGit(subcommand, args, cwd);
  if (result.exitCode !== 0) {
    throw new RunFailure("tool", `git ${subcommand} failed: ${result.stderr.trim() || "exit 1"}`);
  }
}

/**
 * Create the originate {@link EngineRunCore}. Pass it to `createEngine(core)`.
 */
export function createOriginateCore(options: OriginateCoreOptions = {}): EngineRunCore {
  const connect = options.connect ?? defaultConnect;
  const commitMessage = options.commitMessage ?? DEFAULT_COMMIT_MESSAGE;

  return {
    // idle -> form
    startForm(): FormSchema {
      return { fields: [...ORIGINATE_FORM_FIELDS] };
    },

    // form -> running -> decision
    async runToDecision(ctx: RunContext): Promise<DecisionRequest> {
      const session = await connect(ctx.cwd, ctx.signal);

      const textChunks: string[] = [];
      let sawText = false;

      const unsubscribe = session.subscribe((event) => {
        switch (event.type) {
          case "tool_execution_start":
          case "tool_execution_update":
          case "tool_execution_end":
            ctx.emitProgress({ kind: "tool_execution", detail: toolDetail(event) });
            return;
          case "message_update": {
            const inner = event.assistantMessageEvent;
            if (inner.type === "text_delta") {
              textChunks.push(inner.delta);
              sawText = true;
              ctx.emitProgress({ kind: "message_update", detail: inner.delta });
            } else if (inner.type === "thinking_delta") {
              ctx.emitProgress({ kind: "message_update", detail: inner.delta });
            }
            return;
          }
          default:
            return;
        }
      });

      const onAbort = (): void => {
        void session.abort?.();
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      try {
        // Gate to read-only + git BEFORE the turn (takes effect next turn).
        session.setActiveToolsByName([...ORIGINATE_ACTIVE_TOOLS]);

        try {
          await session.prompt(buildImaginePrompt(ctx.values));
        } catch (error) {
          throw new RunFailure("agent", `Imagine pass failed: ${describeError(error)}`);
        }

        // The agent's write tools are gated off → the ENGINE writes the draft.
        const streamed = sawText ? textChunks.join("") : "";
        const draft = streamed.trim().length > 0 ? streamed : fallbackReadme(ctx.values);
        try {
          await writeFile(join(ctx.cwd, README_FILENAME), ensureTrailingNewline(draft), "utf8");
        } catch (error) {
          throw new RunFailure("internal", `Failed to write README.md: ${describeError(error)}`);
        }
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
        unsubscribe();
        await session.dispose();
      }

      return { prompt: COMMIT_DECISION.prompt, options: [...COMMIT_DECISION.options] };
    },

    // decision -> done
    async complete(ctx: CompleteContext): Promise<RunCompletion> {
      const shouldCommit = ctx.choice.trim().toLowerCase() === COMMIT_CHOICE.toLowerCase();
      if (!shouldCommit) {
        // Revise / Cancel: the README draft stays on disk, uncommitted.
        return { artifacts: [], decisions: 1 };
      }

      await runGitStep("init", [], ctx.cwd);
      await runGitStep("add", [README_FILENAME], ctx.cwd);
      await runGitStep("commit", ["-m", commitMessage], ctx.cwd);

      return { artifacts: [README_FILENAME], decisions: 1 };
    },
  };
}
