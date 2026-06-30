import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * Command registered by the SIBYL engine-extension. Registering a uniquely
 * named command makes the extension's binding observable: callers (and tests)
 * can confirm the factory actually loaded into the session.
 */
export const SIBYL_ENGINE_COMMAND = "sibyl-engine";

/**
 * The SIBYL engine-extension factory.
 *
 * SIBYL-001 scope: a MINIMAL stub. Its only job is to bind into the Pi
 * `AgentSession` via `extensionFactories` so `createAgentSession` succeeds and
 * the engine has a hook point to grow into. The real EngineEvent / EngineCommand
 * seam (event stream, state machine, tool gating) is SIBYL-002 — intentionally
 * out of scope here.
 */
export function createSibylEngineExtension(): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerCommand(SIBYL_ENGINE_COMMAND, {
      description: "SIBYL engine-extension binding marker (SIBYL-001 bootstrap stub).",
      handler: async () => {
        // No-op: the seam that drives the agent loop arrives in SIBYL-002.
      },
    });
  };
}
