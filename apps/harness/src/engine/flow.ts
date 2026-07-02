/**
 * AEP orchestration kernel v1 (SIBYL-013) — the determinism layer the whole
 * L1→L6 run stands on. Skills carry JUDGMENT only; STEP DETERMINISM is
 * controlled by the harness through the Pi SDK's own primitives:
 *
 *  - a typed PHASE REGISTRY declaring, per phase, the ONE bundled skill it
 *    carries, its exact tool allowlist, the repo-relative paths it may write,
 *    and the prompt brief appended after {@link SIBYL_PERSONA};
 *  - {@link detectPhase} — deterministic detect-state routing over pure
 *    artifact predicates (same inputs → same answer, always);
 *  - {@link bootPhaseSession} — a FRESH `AgentSession` per phase (context
 *    control) with skills narrowed to exactly the phase's bundled skill and
 *    tools narrowed to the phase allowlist (behavior control);
 *  - {@link createPhaseGuardExtension} — a `tool_call` veto that blocks writes
 *    outside the phase's path allowlist BEFORE they execute (invariant control).
 *
 * Renderer-free by design (ADR-001): this module imports the Pi SDK, never
 * pi-tui. Adding a later AEP phase (map, scaffold, …) requires ONLY a new
 * registry entry plus its bundled skill — zero kernel changes.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import type {
  ExtensionFactory,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import { COCKPIT_ORIGINATE_POINTER, COCKPIT_TOOLS } from "./conversation";
import { createSibylEngineExtension } from "./extension";
import {
  SIBYL_BUNDLED_SKILLS_DIR,
  bootSession,
  type BootSessionOptions,
  type BootedSession,
  type DiscoveredSkills,
} from "./session";
import { registerGitTool } from "../tools/git";

// ---------------------------------------------------------------------------
// (a) Typed phase registry.
// ---------------------------------------------------------------------------

/**
 * The AEP phases the v1 registry routes between. Designed to extend (map,
 * scaffold, …) with zero kernel changes: every kernel function is generic over
 * the id, so a new phase is just a new registry entry + bundled skill.
 */
export type PhaseId = "originate" | "envision";

/**
 * What a phase reads off the PROJECT'S ARTIFACTS to decide where the run
 * stands. Pure predicates over committed/on-disk state — no session state, no
 * conversation memory — so routing is reproducible from the repo alone. The
 * real implementation is {@link createFsArtifactProbe}; tests fake it with two
 * booleans.
 */
export interface ArtifactProbe {
  /** True when `README.md` exists in the COMMITTED tree at `HEAD`. */
  hasCommittedReadme(): boolean;
  /** True when `product/index.yaml` (the envision output artifact) exists. */
  hasProductIndex(): boolean;
}

/** One AEP phase: everything the kernel needs to run it deterministically. */
export interface PhaseSpec<Id extends string = PhaseId> {
  id: Id;
  /** Pure artifact predicate; first matching registry entry (declared order) wins. */
  entryCondition: (probe: ArtifactProbe) => boolean;
  /** The ONE bundled skill this phase carries (its judgment lives there). */
  skillName: string;
  /** Exact active tool names for the phase session. */
  toolAllowlist: string[];
  /** Repo-relative path prefixes the phase may write (enforced by the guard). */
  pathAllowlist: string[];
  /** Appended to the system prompt AFTER {@link SIBYL_PERSONA}. */
  promptBrief: string;
  /**
   * The phase's typed submit tool (arrives in SIBYL-014; the registry only
   * names it). The guard exempts it: the submit tool owns the artifact write.
   * `null` for phases that write their artifact directly (e.g. originate).
   */
  completionToolName: string | null;
}

/**
 * The envision-phase brief. Like the originate pointer, it only ACTIVATES the
 * bundled skill from turn 1 — the flow's substance ships as the
 * `sibyl-envision` SKILL.md (arrives in SIBYL-015; the registry names it now).
 */
export const ENVISION_BRIEF =
  "You are in SIBYL's ENVISION phase. The project's committed README is the focused Goal; your job is " +
  "product-level framing on top of it. Before your first reply, use the `read` tool to load the " +
  "`sibyl-envision` skill (its SKILL.md <location> is listed in your available skills) and CONDUCT " +
  "that flow from turn 1. Do NOT write artifact files directly — when the framing is agreed, submit " +
  "it with the `submit_envision` tool.";

/**
 * AEP phase registry v1. DECLARED ORDER IS LOAD-BEARING: {@link detectPhase}
 * returns the first entry whose `entryCondition` matches.
 *
 *  - `originate` — no committed README yet: focus the idea into one. Carries
 *    the existing cockpit tool set; may write only the README + git metadata.
 *  - `envision` — committed README, no `product/index.yaml` yet: product
 *    framing on top of the Goal. Read-only discovery plus the typed
 *    `submit_envision` tool (SIBYL-014), which owns the artifact write — hence
 *    the empty path allowlist.
 */
export const PHASE_REGISTRY: ReadonlyArray<PhaseSpec> = [
  {
    id: "originate",
    entryCondition: (probe) => !probe.hasCommittedReadme(),
    skillName: "sibyl-originate",
    toolAllowlist: [...COCKPIT_TOOLS],
    pathAllowlist: ["README.md", ".git"],
    promptBrief: COCKPIT_ORIGINATE_POINTER,
    completionToolName: null,
  },
  {
    id: "envision",
    entryCondition: (probe) => probe.hasCommittedReadme() && !probe.hasProductIndex(),
    skillName: "sibyl-envision",
    toolAllowlist: ["read", "grep", "find", "ls", "submit_envision"],
    pathAllowlist: [],
    promptBrief: ENVISION_BRIEF,
    completionToolName: "submit_envision",
  },
];

/** Look up a v1 registry entry by id (throws on an unregistered id). */
export function getPhaseSpec(id: PhaseId): PhaseSpec {
  const spec = PHASE_REGISTRY.find((entry) => entry.id === id);
  if (!spec) {
    throw new Error(`getPhaseSpec: phase "${id}" is not in the registry.`);
  }
  return spec;
}

// ---------------------------------------------------------------------------
// (b) detectPhase — deterministic detect-state routing.
// ---------------------------------------------------------------------------

/**
 * Route to the current AEP phase from the project's artifacts alone. Walks
 * `registry` in DECLARED ORDER and returns the first entry whose pure
 * `entryCondition` matches — same artifacts, same answer, always.
 *
 * Throws when nothing matches (all v1 artifacts already present): the caller
 * learns explicitly that the run is beyond the registered phases, rather than
 * being silently routed somewhere wrong.
 */
export function detectPhase<Id extends string = PhaseId>(
  probe: ArtifactProbe,
  registry?: ReadonlyArray<PhaseSpec<Id>>,
): Id {
  // Safe cast: when `registry` is omitted, Id can only be its default, PhaseId.
  const entries = registry ?? (PHASE_REGISTRY as unknown as ReadonlyArray<PhaseSpec<Id>>);
  for (const spec of entries) {
    if (spec.entryCondition(probe)) {
      return spec.id;
    }
  }
  throw new Error(
    "detectPhase: no phase entry condition matched the project's artifacts " +
      `(checked, in order: ${entries.map((spec) => spec.id).join(", ")}). ` +
      "Later AEP phases are not registered yet.",
  );
}

/**
 * The real fs/git-backed {@link ArtifactProbe} for a project directory.
 * Each predicate reads live state, so one probe stays accurate as the project
 * evolves. "Committed" means present in the tree at `HEAD` — a written-but-
 * uncommitted README does NOT advance the phase (git is the source of truth).
 */
export function createFsArtifactProbe(cwd: string): ArtifactProbe {
  return {
    hasCommittedReadme(): boolean {
      try {
        // Exit 0 iff HEAD resolves AND its tree contains README.md.
        // Throws for: not a git repo, no commits yet, or README not committed.
        execFileSync("git", ["cat-file", "-e", "HEAD:README.md"], { cwd, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
    hasProductIndex(): boolean {
      return existsSync(join(cwd, "product", "index.yaml"));
    },
  };
}

// ---------------------------------------------------------------------------
// (c) bootPhaseSession — a fresh, narrowed AgentSession per phase.
// ---------------------------------------------------------------------------

/** Options for {@link bootPhaseSession}: the project dir + bootSession passthrough. */
export interface BootPhaseSessionOptions extends BootSessionOptions {
  /** The project directory the phase session works in. */
  cwd: string;
}

/**
 * Boot a FRESH `AgentSession` for one AEP phase, built on {@link bootSession}:
 *
 *  - **Skills** narrowed to EXACTLY `spec.skillName`, and only when it loads
 *    from a HARNESS-trusted root ({@link SIBYL_BUNDLED_SKILLS_DIR} plus any
 *    caller `additionalSkillPaths`). Skills discovered from the user project's
 *    git root NEVER surface — not even one that shadows the phase skill's name.
 *  - **Tools** restricted to `spec.toolAllowlist` (via `createAgentSession`'s
 *    `tools` allowlist AND `setActiveToolsByName`, which also rebuilds the
 *    system prompt so the narrowed skill/tool set is reflected immediately).
 *  - **Prompt**: {@link SIBYL_PERSONA} stays first (bootSession prepends it),
 *    followed by `spec.promptBrief`, then any caller fragments.
 *  - **Guard**: {@link createPhaseGuardExtension} is ALWAYS bound, so writes
 *    outside `spec.pathAllowlist` are vetoed pre-execution.
 *
 * Note: a phase session OWNS its skill narrowing — any caller-supplied
 * `skillsOverride` is replaced by the phase's own.
 */
export async function bootPhaseSession(
  spec: PhaseSpec<string>,
  options: BootPhaseSessionOptions,
): Promise<BootedSession> {
  const { cwd, ...rest } = options;
  const trustedSkillRoots = [SIBYL_BUNDLED_SKILLS_DIR, ...(rest.additionalSkillPaths ?? [])];
  const booted = await bootSession(cwd, {
    ...rest,
    extensionFactories: [
      // Same default binding as bootSession + the cockpit (engine extension +
      // narrow git tool), unless the caller supplies its own factories…
      ...(rest.extensionFactories ?? [
        createSibylEngineExtension(),
        (pi) => registerGitTool(pi),
      ]),
      // …but the invariant guard is ALWAYS bound, caller factories or not.
      createPhaseGuardExtension(spec),
    ],
    appendSystemPrompt: [spec.promptBrief, ...(rest.appendSystemPrompt ?? [])],
    skillsOverride: (base) => narrowToPhaseSkill(base, spec.skillName, trustedSkillRoots),
    tools: [...spec.toolAllowlist],
  });
  // `tools` above already restricts creation; re-asserting by name also forces
  // a system-prompt rebuild reflecting the final narrowed tool set. Names the
  // registry declares ahead of their tool (e.g. `submit_envision` before
  // SIBYL-014 lands) are ignored by the SDK until that tool is registered.
  booted.session.setActiveToolsByName([...spec.toolAllowlist]);
  return booted;
}

/**
 * Keep ONLY the phase's skill, and only from a harness-trusted root. This is
 * what guarantees the assembled system prompt's Agent-Skills block surfaces
 * exactly one skill — and that nothing discovered from the USER project's git
 * root (default discovery walks it) leaks into a phase session.
 */
function narrowToPhaseSkill(
  base: DiscoveredSkills,
  skillName: string,
  trustedRoots: readonly string[],
): DiscoveredSkills {
  const skills = base.skills.filter(
    (skill) =>
      skill.name === skillName &&
      trustedRoots.some((root) => skill.filePath.startsWith(root.endsWith(sep) ? root : root + sep)),
  );
  return { skills, diagnostics: base.diagnostics };
}

// ---------------------------------------------------------------------------
// (d) Invariant guard — tool_call veto on out-of-allowlist writes.
// ---------------------------------------------------------------------------

/** Tools that only READ project state — the guard always lets them through. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

/** The slice of a Pi `tool_call` event the guard evaluates. */
export interface PhaseToolCall {
  toolName: string;
  input: unknown;
}

/**
 * The phase invariant guard: an extension registering `pi.on("tool_call", …)`
 * that vetoes, PRE-EXECUTION, any write-capable call targeting a path outside
 * `spec.pathAllowlist`. Read-only tools always pass; the phase's completion
 * tool (when named) is exempt — it owns the artifact write; anything else that
 * can mutate state is DEFAULT-DENIED. The block reason is model-readable and
 * actionable so the agent can self-correct.
 */
export function createPhaseGuardExtension(spec: PhaseSpec<string>): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", (event, ctx) => evaluatePhaseToolCall(spec, ctx.cwd, event));
  };
}

/**
 * Pure decision core of the guard (unit-testable without a session): allow
 * (`undefined`) or `{ block: true, reason }` for one tool call against one
 * phase spec, resolving targets against the session's `cwd`.
 */
export function evaluatePhaseToolCall(
  spec: PhaseSpec<string>,
  cwd: string,
  call: PhaseToolCall,
): ToolCallEventResult | undefined {
  if (READ_ONLY_TOOLS.has(call.toolName)) {
    return undefined;
  }
  if (spec.completionToolName !== null && call.toolName === spec.completionToolName) {
    // The typed submit tool (SIBYL-014) owns the phase's artifact write.
    return undefined;
  }

  const targets = extractWriteTargets(call.toolName, asRecord(call.input), cwd);
  if (targets === null) {
    // DEFAULT-DENY: an unrecognized (or unparseable) tool call that may mutate state.
    return blockResult(
      spec,
      `Tool "${call.toolName}" is not a read-only tool and its write target could not be verified.`,
    );
  }
  for (const target of targets) {
    if (!isWithinAllowlist(target, spec.pathAllowlist)) {
      return blockResult(spec, `Blocked ${call.toolName} targeting "${target}".`);
    }
  }
  return undefined;
}

/**
 * Repo-relative write target(s) of a tool call, or `null` when they cannot be
 * determined (→ default-deny). Path-extraction rules per tool:
 *
 *  - `write` / `edit`: the file-path field (`path`, with `file_path` accepted
 *    as the SDK's own compat alias), resolved against the session cwd.
 *  - `git init`: writes only repository metadata → `.git` (resolved against
 *    the call's own `cwd` argument, falling back to the session cwd).
 *  - `git add <pathspec…>`: the non-flag args, resolved against the call cwd.
 *  - `git commit`: `.git` metadata, plus any pathspec args — skipping the
 *    values consumed by `-m/--message/-F/--file` so a commit MESSAGE is never
 *    mistaken for a path.
 *  - any other git subcommand, or any other tool: `null` (default-deny).
 */
function extractWriteTargets(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): string[] | null {
  switch (toolName) {
    case "write":
    case "edit": {
      const raw = firstString(input, ["path", "file_path"]);
      return raw === undefined ? null : [toRepoRelative(raw, cwd, cwd)];
    }
    case "git":
      return gitWriteTargets(input, cwd);
    default:
      return null;
  }
}

/** See {@link extractWriteTargets} for the per-subcommand rules. */
function gitWriteTargets(input: Record<string, unknown>, cwd: string): string[] | null {
  const subcommand = typeof input["subcommand"] === "string" ? input["subcommand"] : undefined;
  if (subcommand === undefined) {
    return null;
  }
  const gitCwd = typeof input["cwd"] === "string" ? input["cwd"] : cwd;
  const args = Array.isArray(input["args"])
    ? input["args"].filter((arg): arg is string => typeof arg === "string")
    : [];

  switch (subcommand) {
    case "init":
      return [toRepoRelative(".git", gitCwd, cwd)];
    case "add":
      return args
        .filter((arg) => !arg.startsWith("-"))
        .map((arg) => toRepoRelative(arg, gitCwd, cwd));
    case "commit": {
      const targets = [toRepoRelative(".git", gitCwd, cwd)];
      const flagsWithValue = new Set(["-m", "--message", "-F", "--file"]);
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === undefined) {
          continue;
        }
        if (flagsWithValue.has(arg)) {
          i += 1; // skip the flag's value (a message/file, not a pathspec)
          continue;
        }
        if (arg.startsWith("-")) {
          continue; // other flags, incl. -mMsg / --message=… forms
        }
        targets.push(toRepoRelative(arg, gitCwd, cwd));
      }
      return targets;
    }
    default:
      return null;
  }
}

/**
 * Resolve `rawPath` against `baseDir` and express it relative to the project
 * `cwd`. Escaping paths come back with a leading `..` (or as `.` for the root
 * itself), which no allowlist prefix ever matches — so they read clearly in
 * the block reason AND fail the check.
 */
function toRepoRelative(rawPath: string, baseDir: string, cwd: string): string {
  const rel = relative(cwd, resolve(baseDir, rawPath));
  return rel === "" ? "." : rel;
}

/** True when `target` equals an allowlist entry or falls under one (prefix + `/`). */
function isWithinAllowlist(target: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => {
    const prefix = entry.replace(/\/+$/, "");
    return target === prefix || target.startsWith(`${prefix}/`);
  });
}

/** The structured veto, phrased so the model can self-correct. */
function blockResult(spec: PhaseSpec<string>, detail: string): ToolCallEventResult {
  const scope =
    spec.pathAllowlist.length > 0 ? spec.pathAllowlist.join(", ") : "(no direct file writes)";
  const hint = spec.completionToolName
    ? ` Submit this phase's artifact with the \`${spec.completionToolName}\` tool instead.`
    : "";
  return {
    block: true,
    reason: `${spec.id} phase may only write within: ${scope}. ${detail}${hint}`,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}
