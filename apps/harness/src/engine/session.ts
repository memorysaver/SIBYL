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
 * Discover the skills resolvable from `cwd` (walks to the git root to find
 * `.agents/skills/*`). Used to confirm `aep-*` skills are visible to a booted
 * session without having to create the session itself.
 */
export async function discoverSkills(
  cwd: string,
  options: BootSessionOptions = {},
): Promise<Skill[]> {
  const loader = createSibylResourceLoader(cwd, options);
  await loader.reload();
  return loader.getSkills().skills;
}
