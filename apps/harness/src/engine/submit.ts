/**
 * SIBYL-014: Typed phase completion — `createSubmitTool`.
 *
 * A per-phase Pi custom tool whose TypeBox `parameters` schema IS the phase's
 * output contract. The SDK validates arguments against the schema BEFORE
 * `execute` runs (schema-invalid calls come back to the model as tool errors it
 * can retry); inside `execute` a SEMANTIC validator rejects payloads that are
 * well-typed but wrong (duplicate ids, unsorted layers, …) by throwing an
 * actionable error — the Pi agent loop converts a thrown error into an
 * `isError: true` tool result the model can self-correct from.
 *
 * On a VALID call the HARNESS (never the model) owns the side effects:
 *
 *  1. serializes the canonical YAML artifact and writes it under the session cwd,
 *  2. git-commits it via a harness-side git runner (injectable; default
 *     {@link runGit} — NOT the model's `git` tool),
 *  3. fires the injected hooks: `onPhaseCompleted(phase, payload)` and a
 *     {@link DecisionEntry}-shaped decision sink (the SIBYL-011 injectable-sink
 *     pattern), and
 *  4. returns success content summarizing what was written.
 *
 * The factory is generic: `envision` is the first instance; a later phase
 * (map, scaffold, …) needs ONLY a new schema + serializer — zero changes here.
 * Injectable clock/exec keep the logic testable (no `Date.now` in pure logic).
 *
 * Renderer-free by design (ADR-001): imports the Pi SDK, never pi-tui.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TObject } from "typebox";
import { stringify } from "yaml";

import { runGit, type GitResult } from "../tools/git";
import type { DecisionEntry } from "../memory/decisions";

// ---------------------------------------------------------------------------
// (a) The generic factory.
// ---------------------------------------------------------------------------

/**
 * The slice of a `PhaseSpec` a submit tool needs (structural — `PhaseSpec`
 * satisfies it). Kept minimal so this module never runtime-imports `flow.ts`
 * (flow.ts runtime-imports THIS module for the registry wiring; the reverse
 * edge would be a cycle).
 */
export interface SubmitPhaseRef {
  /** The phase the tool completes (e.g. `envision`). */
  id: string;
  /** The tool's name — the guard-exempt completion tool of the phase. */
  completionToolName: string | null;
}

/** Harness-side git runner (injectable for tests; default {@link runGit}). */
export type SubmitGitRunner = (
  subcommand: "add" | "commit",
  args: string[],
  cwd: string,
) => Promise<GitResult>;

/** Sink for the phase-completion decision (mirrors conversation.ts's `DecisionSink`). */
export type SubmitDecisionSink = (entry: DecisionEntry) => void;

/**
 * The injectable seams a caller (e.g. `bootPhaseSession`) threads into a
 * phase's completion tool. All optional: production defaults are `Date.now`,
 * {@link runGit}, and no-op hooks.
 */
export interface PhaseCompletionHooks {
  /** Timestamp source for the decision entry (deterministic in tests). Default: `Date.now`. */
  now?: () => number;
  /** Harness-side git runner for the artifact commit. Default: {@link runGit}. */
  exec?: SubmitGitRunner;
  /** Fired after the artifact is written AND committed. */
  onPhaseCompleted?: (phase: string, payload: unknown) => void;
  /** Receives the phase-completion {@link DecisionEntry}. */
  decisionSink?: SubmitDecisionSink;
}

/** Options for {@link createSubmitTool}: the phase's output contract + writers. */
export interface CreateSubmitToolOptions<T extends TObject> {
  /** The phase this tool completes; its `completionToolName` names the tool. */
  spec: SubmitPhaseRef;
  /** The TypeBox schema — the phase's output contract (SDK-validated pre-execute). */
  schema: T;
  /** LLM-facing tool description. */
  description: string;
  /** Serialize a valid payload to the canonical artifact text (e.g. YAML). */
  serialize: (payload: Static<T>) => string;
  /**
   * SEMANTIC validation beyond the schema. Returns actionable messages naming
   * the offending fields; non-empty ⇒ the call is rejected with NO side effects.
   */
  semanticErrors?: (payload: Static<T>) => string[];
  /** Repo-relative path of the artifact the tool writes (e.g. `product/index.yaml`). */
  artifactRelPath: string;
  /** Commit message for the harness-side artifact commit. */
  commitMessage: string;
  /** The `decision` text of the emitted {@link DecisionEntry}. */
  decisionText: string;
  /** One-line payload summary folded into the success content. */
  summarize?: (payload: Static<T>) => string;
  /** Timestamp source (deterministic in tests). Default: `Date.now`. */
  now?: () => number;
  /** Harness-side git runner. Default: {@link runGit}. */
  exec?: SubmitGitRunner;
  /** Fired after the artifact is written AND committed. */
  onPhaseCompleted?: (phase: string, payload: Static<T>) => void;
  /** Receives the phase-completion {@link DecisionEntry}. */
  decisionSink?: SubmitDecisionSink;
}

/** Structured details of a successful submit (for logs/UI). */
export interface SubmitToolDetails {
  phase: string;
  artifactRelPath: string;
  commitMessage: string;
}

/**
 * Build a phase's typed completion tool. See the module docs for the contract;
 * throws immediately when the phase declares no `completionToolName` (a submit
 * tool for such a phase is a wiring bug, not a runtime condition).
 */
export function createSubmitTool<T extends TObject>(
  options: CreateSubmitToolOptions<T>,
): ToolDefinition<T, SubmitToolDetails> {
  const { spec, schema, serialize, semanticErrors, artifactRelPath, commitMessage } = options;
  const toolName = spec.completionToolName;
  if (toolName === null) {
    throw new Error(
      `createSubmitTool: phase "${spec.id}" declares no completion tool ` +
        "(completionToolName is null) — nothing to build.",
    );
  }
  const now = options.now ?? Date.now;
  const exec = options.exec ?? runGit;

  return defineTool({
    name: toolName,
    label: `Submit ${spec.id}`,
    description: options.description,
    parameters: schema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // SEMANTIC validation (schema validation already ran pre-execute).
      // Throwing is the SDK's semantic-reject path: the agent loop converts it
      // to an `isError: true` tool result whose content is this message, so the
      // model can fix the named fields and retry. NOTHING below runs.
      const errors = semanticErrors?.(params) ?? [];
      if (errors.length > 0) {
        throw new Error(
          `${toolName} rejected the submission — nothing was written or committed. ` +
            `Fix the following and call ${toolName} again:\n` +
            errors.map((message) => `- ${message}`).join("\n"),
        );
      }

      // 1. The HARNESS serializes and writes the canonical artifact.
      const artifactAbsPath = join(ctx.cwd, artifactRelPath);
      await mkdir(dirname(artifactAbsPath), { recursive: true });
      await writeFile(artifactAbsPath, serialize(params), "utf8");

      // 2. The HARNESS commits it (never routed through the model's git tool).
      await execOrThrow(exec, "add", [artifactRelPath], ctx.cwd, toolName);
      await execOrThrow(exec, "commit", ["-m", commitMessage], ctx.cwd, toolName);

      // 3. Completion hooks — only after the artifact is durably committed.
      const at = now();
      options.onPhaseCompleted?.(spec.id, params);
      options.decisionSink?.({
        id: `${spec.id}-${at}`,
        phase: spec.id,
        decision: options.decisionText,
        at,
      });

      // 4. Success content summarizing what was written.
      const summary = options.summarize?.(params);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Phase "${spec.id}" is complete: wrote ${artifactRelPath}` +
              `${summary ? ` (${summary})` : ""} and committed it — "${commitMessage}".`,
          },
        ],
        details: { phase: spec.id, artifactRelPath, commitMessage },
      };
    },
  });
}

/** Run one harness-side git step; a non-zero exit becomes an actionable throw. */
async function execOrThrow(
  exec: SubmitGitRunner,
  subcommand: "add" | "commit",
  args: string[],
  cwd: string,
  toolName: string,
): Promise<void> {
  const result = await exec(subcommand, args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(
      `${toolName}: the artifact was written but \`git ${subcommand}\` failed ` +
        `(exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim() || "no output"}`,
    );
  }
}

// ---------------------------------------------------------------------------
// (b) The envision instance — `submit_envision`.
// ---------------------------------------------------------------------------

/** The envision phase's completion tool name (single source for the registry). */
export const SUBMIT_ENVISION_TOOL_NAME = "submit_envision";

/** Repo-relative path of the envision output artifact. */
export const ENVISION_ARTIFACT_RELPATH = "product/index.yaml";

/** Commit message of the harness-side envision artifact commit. */
export const ENVISION_COMMIT_MESSAGE = "feat(envision): commit product/index.yaml (product framing)";

/** The `decision` text of the envision-completion {@link DecisionEntry}. */
export const ENVISION_DECISION_TEXT = "Committed product/index.yaml (envision framing)";

/**
 * The envision output contract: the structured product framing, field names
 * aligned with the split-mode `product/index.yaml` shape (personas top-level;
 * problem / mvp_boundary / layers / activities under `product:`) so
 * SIBYL-generated projects are AEP-compatible from birth. Required core fields
 * only; extras (goals, non_goals, activity descriptions) are optional so the
 * model can fill the schema from an interview.
 */
export const EnvisionSubmissionSchema = Type.Object({
  problem: Type.String({
    minLength: 1,
    description:
      "The product problem statement: who has the problem and why it matters (maps to product.problem).",
  }),
  personas: Type.Array(
    Type.Object({
      name: Type.String({ minLength: 1, description: "Short persona name (e.g. solo-aep-builder)." }),
      description: Type.String({ minLength: 1, description: "Who this persona is and what they need." }),
    }),
    { minItems: 1, description: "The personas the product serves (maps to personas)." },
  ),
  activities: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1, description: "Stable kebab-case activity id (unique)." }),
      name: Type.String({ minLength: 1, description: "Human-readable activity name." }),
      order: Type.Integer({ minimum: 1, description: "1-based backbone position." }),
      layer_introduced: Type.Number({
        minimum: 0,
        description: "The layer at which this activity first becomes usable.",
      }),
      description: Type.Optional(Type.String({ description: "What the user does in this activity." })),
    }),
    { minItems: 1, description: "The backbone activities of the user journey (maps to product.activities)." },
  ),
  layers: Type.Array(
    Type.Object({
      layer: Type.Number({ minimum: 0, description: "Layer number (ascending, unique)." }),
      name: Type.String({ minLength: 1, description: "Layer name (e.g. walking skeleton)." }),
      user_can: Type.String({ minLength: 1, description: "What the user can DO once this layer ships." }),
    }),
    { minItems: 1, description: "The release layers, thinnest first (maps to product.layers)." },
  ),
  mvp_boundary: Type.Object(
    {
      in_scope: Type.Array(Type.String(), {
        minItems: 1,
        description: "What the MVP definitely includes.",
      }),
      out_of_scope: Type.Array(Type.String(), { description: "What the MVP explicitly excludes." }),
    },
    { description: "The MVP boundary (maps to product.mvp_boundary)." },
  ),
  goals: Type.Optional(Type.Array(Type.String(), { description: "Product goals (maps to product.goals)." })),
  non_goals: Type.Optional(
    Type.Array(Type.String(), { description: "Explicit non-goals (maps to product.non_goals)." }),
  ),
});

/** A validated envision submission (the `submit_envision` payload). */
export type EnvisionSubmission = Static<typeof EnvisionSubmissionSchema>;

/**
 * SEMANTIC validation of an envision submission — the rules a JSON schema
 * cannot express. Pure; returns actionable messages naming the offending field
 * (empty array = valid).
 */
export function envisionSemanticErrors(payload: EnvisionSubmission): string[] {
  const errors: string[] = [];

  if (payload.problem.trim().length === 0) {
    errors.push("problem: must be a non-empty product problem statement.");
  }
  if (payload.personas.length < 1) {
    errors.push("personas: at least one persona is required.");
  }

  if (payload.activities.length < 1) {
    errors.push("activities: at least one activity is required.");
  }
  const seenActivityIds = new Set<string>();
  for (const activity of payload.activities) {
    if (seenActivityIds.has(activity.id)) {
      errors.push(`activities: duplicate id "${activity.id}" — activity ids must be unique.`);
    }
    seenActivityIds.add(activity.id);
  }

  if (payload.layers.length < 1) {
    errors.push("layers: at least one layer is required.");
  }
  for (let i = 1; i < payload.layers.length; i++) {
    const prev = payload.layers[i - 1];
    const curr = payload.layers[i];
    if (prev === undefined || curr === undefined) {
      continue;
    }
    if (curr.layer === prev.layer) {
      errors.push(`layers: duplicate layer ${curr.layer} — layer numbers must be unique.`);
    } else if (curr.layer < prev.layer) {
      errors.push(
        `layers: must be sorted ascending by \`layer\` (found layer ${curr.layer} after layer ${prev.layer}).`,
      );
    }
  }

  if (payload.mvp_boundary.in_scope.every((item) => item.trim().length === 0)) {
    errors.push("mvp_boundary.in_scope: must contain at least one non-empty in-scope item.");
  }

  return errors;
}

/**
 * Serialize an envision submission as the canonical `product/index.yaml` text.
 * The document shape mirrors the split-mode product definition (personas
 * top-level; problem / goals / non_goals / mvp_boundary / layers / activities
 * under `product:`) with a fixed key order, so the output is deterministic
 * regardless of the model's JSON field order.
 */
export function serializeEnvisionYaml(payload: EnvisionSubmission): string {
  const document = {
    schema: "v1",
    personas: payload.personas.map((persona) => ({
      name: persona.name,
      description: persona.description,
    })),
    product: {
      problem: payload.problem,
      ...(payload.goals !== undefined && payload.goals.length > 0 ? { goals: payload.goals } : {}),
      ...(payload.non_goals !== undefined && payload.non_goals.length > 0
        ? { non_goals: payload.non_goals }
        : {}),
      mvp_boundary: {
        in_scope: payload.mvp_boundary.in_scope,
        out_of_scope: payload.mvp_boundary.out_of_scope,
      },
      layers: payload.layers.map((layer) => ({
        layer: layer.layer,
        name: layer.name,
        user_can: layer.user_can,
      })),
      activities: payload.activities.map((activity) => ({
        id: activity.id,
        name: activity.name,
        ...(activity.description !== undefined ? { description: activity.description } : {}),
        order: activity.order,
        layer_introduced: activity.layer_introduced,
      })),
    },
  };
  return stringify(document);
}

/**
 * Build `submit_envision` — the envision phase's typed completion tool, the
 * ONE path that produces `product/index.yaml` (the SIBYL-013 guard vetoes raw
 * writes and exempts exactly this tool). First instance of
 * {@link createSubmitTool}; later phases add only a schema + serializer.
 */
export function createEnvisionSubmitTool(
  hooks: PhaseCompletionHooks = {},
): ToolDefinition<typeof EnvisionSubmissionSchema, SubmitToolDetails> {
  return createSubmitTool({
    spec: { id: "envision", completionToolName: SUBMIT_ENVISION_TOOL_NAME },
    schema: EnvisionSubmissionSchema,
    description:
      "Submit the agreed product framing to COMPLETE the envision phase. The harness " +
      "writes product/index.yaml from this structured payload and git-commits it — do " +
      "NOT write the file yourself. Call this exactly once, after the framing " +
      "(problem, personas, activities, layers, MVP boundary) is agreed with the user.",
    serialize: serializeEnvisionYaml,
    semanticErrors: envisionSemanticErrors,
    artifactRelPath: ENVISION_ARTIFACT_RELPATH,
    commitMessage: ENVISION_COMMIT_MESSAGE,
    decisionText: ENVISION_DECISION_TEXT,
    summarize: (payload) =>
      `${payload.personas.length} persona(s), ${payload.activities.length} activities, ` +
      `${payload.layers.length} layers, ${payload.mvp_boundary.in_scope.length} in-scope item(s)`,
    ...hooks,
  });
}
