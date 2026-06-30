import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SIBYL_ENGINE_COMMAND } from "../src/engine/extension";
import { bootSession } from "../src/engine/session";

// The harness package dir. Skill/extension discovery walks up to the git root.
const cwd = fileURLToPath(new URL("..", import.meta.url));

describe("bootSession (unit)", () => {
  it("returns a Pi session bound to the SIBYL engine-extension via extensionFactories", async () => {
    const { session, extensionsResult } = await bootSession(cwd);

    try {
      // createAgentSession returned a usable AgentSession.
      expect(typeof session.prompt).toBe("function");
      expect(typeof session.subscribe).toBe("function");

      // The engine-extension loaded cleanly via extensionFactories...
      expect(extensionsResult.errors).toEqual([]);
      expect(extensionsResult.extensions.length).toBeGreaterThanOrEqual(1);

      // ...and it is OUR extension: the factory registered the marker command.
      const boundCommands = extensionsResult.extensions.flatMap((ext) => [...ext.commands.keys()]);
      expect(boundCommands).toContain(SIBYL_ENGINE_COMMAND);
    } finally {
      await session.dispose();
    }
  });
});
