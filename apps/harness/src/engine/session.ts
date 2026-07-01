import { fileURLToPath } from "node:url";

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ExtensionFactory,
  type LoadExtensionsResult,
  type ResourceLoader,
  type Skill,
} from "@earendil-works/pi-coding-agent";

import { createSibylEngineExtension } from "./extension";

/**
 * SIBYL's foundational role, prepended to the system prompt of EVERY session
 * (before any caller-supplied brief such as the cockpit's thin originate pointer).
 * It gives the agent its identity — SIBYL, an agentic coding-workflow agent running
 * a Specification-Bound Intelligent Yield Loop — so it frames every task as
 * software engineering, not open-ended chat. This is the UX foundation the
 * guided flows build on; the flow-specific brief comes after it.
 */
export const SIBYL_PERSONA =
  "You are SIBYL — the agentic coding-workflow agent, built on the Specification-Bound Intelligent " +
  "Yield Loop. You carry out real SOFTWARE-ENGINEERING work: you take a specification and drive it to " +
  "working, verified software through a disciplined, spec-bound loop — you CONDUCT that workflow rather " +
  "than improvising it. Approach every task as a software-engineering task, grounded in the project's " +
  "specs and artifacts.";

/**
 * Absolute path to the harness-BUNDLED Pi skills directory (`apps/harness/skills`),
 * resolved relative to THIS module via `import.meta.url` — NOT the run cwd. This is
 * SIBYL's thesis in packaging form: the guided flows ship as discoverable Pi skills
 * (a `SKILL.md` per skill) rather than hardcoded prompt strings.
 *
 * Why package-relative and not cwd-relative? Normal skill discovery walks the
 * USER's git root for `.agents/skills/*` (see {@link discoverSkills}). When
 * `sibyl cockpit --cwd /some/user/project` runs, that walk finds the user's skills
 * but would MISS SIBYL's own bundled skills. Resolving from `import.meta.url` ties
 * the path to where the harness is installed, so the bundled skills (e.g.
 * `sibyl-originate`) are found in ANY project. Wired in via `additionalSkillPaths`.
 */
export const SIBYL_BUNDLED_SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));

export interface BootSessionOptions {
  /** Global Pi config dir (global skills/extensions). Default: `getAgentDir()` (~/.pi/agent). */
  agentDir?: string;
  /**
   * Where to persist session state. Default: an in-memory store so a bootstrap
   * boot has no disk side effects. Real persistence / resume is a later story.
   */
  sessionManager?: SessionManager;
  /** Engine-extension factories to bind. Default: `[createSibylEngineExtension()]`. */
  extensionFactories?: ExtensionFactory[];
  /**
   * Extra system-prompt fragments appended after the base prompt (e.g. a
   * guided-flow brief). {@link SIBYL_PERSONA} is always prepended ahead of these,
   * so the agent's SIBYL identity comes first and the flow brief follows.
   */
  appendSystemPrompt?: string[];
  /**
   * Extra skill directories to discover, on top of SIBYL's bundled skills.
   * {@link SIBYL_BUNDLED_SKILLS_DIR} is always registered ahead of these, so
   * SIBYL's own skills (e.g. `sibyl-originate`) resolve regardless of the run cwd.
   */
  additionalSkillPaths?: string[];
}

export interface BootedSession {
  /** The Pi `AgentSession` (`prompt`, `subscribe`, `abort`, `dispose`, …). */
  session: AgentSession;
  /** The resource loader that discovered skills/extensions for this session. */
  loader: ResourceLoader;
  /** Result of loading the engine-extension(s) — `extensions`, `errors`, `runtime`. */
  extensionsResult: LoadExtensionsResult;
}

function createSibylResourceLoader(
  cwd: string,
  options: BootSessionOptions,
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    agentDir: options.agentDir ?? getAgentDir(),
    extensionFactories: options.extensionFactories ?? [createSibylEngineExtension()],
    // Ship SIBYL's OWN skills with the harness: register the package-relative
    // bundled-skills dir so they resolve regardless of the run cwd (the default
    // discovery only walks the user's git root). This is how `sibyl-originate` is
    // found when `sibyl cockpit --cwd <user project>` runs. See
    // {@link SIBYL_BUNDLED_SKILLS_DIR}.
    additionalSkillPaths: [SIBYL_BUNDLED_SKILLS_DIR, ...(options.additionalSkillPaths ?? [])],
    // SIBYL_PERSONA is always first, so every session self-identifies as SIBYL
    // before any flow-specific brief (e.g. the cockpit originate pointer) a caller appends.
    appendSystemPrompt: [SIBYL_PERSONA, ...(options.appendSystemPrompt ?? [])],
  });
}

/**
 * Boot a Pi `AgentSession` for `cwd`, bound to the SIBYL engine-extension.
 *
 * Configures a `DefaultResourceLoader` with the SIBYL engine-extension factory,
 * reloads it (which discovers `.agents/skills/*` by walking to the git root),
 * and creates the session via `createAgentSession`. This is the foundation every
 * later engine layer builds on.
 */
export async function bootSession(
  cwd: string,
  options: BootSessionOptions = {},
): Promise<BootedSession> {
  const loader = createSibylResourceLoader(cwd, options);
  await loader.reload();

  const { session, extensionsResult } = await createAgentSession({
    cwd,
    resourceLoader: loader,
    sessionManager: options.sessionManager ?? SessionManager.inMemory(cwd),
  });

  return { session, loader, extensionsResult };
}

/**
 * Discover the skills resolvable from `cwd`: the project's own skills (walks to
 * the git root to find `.agents/skills/*`) PLUS SIBYL's harness-bundled skills
 * (registered via {@link SIBYL_BUNDLED_SKILLS_DIR}, so `sibyl-originate` resolves
 * from ANY cwd). Used to confirm both the `aep-*` skills AND the bundled skills
 * are visible to a booted session without having to create the session itself.
 */
export async function discoverSkills(
  cwd: string,
  options: BootSessionOptions = {},
): Promise<Skill[]> {
  const loader = createSibylResourceLoader(cwd, options);
  await loader.reload();
  return loader.getSkills().skills;
}
