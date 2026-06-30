import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * SIBYL-006 acceptance criterion 2: the renderer consumes ONLY EngineEvents and
 * contains NO Pi SDK import. It MAY import the `@earendil-works/pi-tui` UI
 * library, but NOT `@earendil-works/pi-coding-agent` / `pi-agent` (the
 * SDK/agent). This mirrors SIBYL-002's source scan for `ctx.ui` in the engine.
 */

// Strip comments so the scan inspects CODE, not documentation (this file and the
// renderer JSDoc legitimately NAME the forbidden packages to explain the rule).
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const rendererDir = fileURLToPath(new URL("../src/renderer", import.meta.url));
const sources = readdirSync(rendererDir)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => ({ name, code: stripComments(readFileSync(`${rendererDir}/${name}`, "utf8")) }));

describe("ADR-001 invariant: renderer consumes ONLY EngineEvents (no Pi SDK)", () => {
  it("reads the renderer source files", () => {
    expect(sources.length).toBeGreaterThanOrEqual(2); // app.ts, progress.ts
  });

  it("imports the Pi SDK / agent nowhere in renderer CODE", () => {
    for (const { name, code } of sources) {
      expect(code, `${name} must not import the Pi SDK`).not.toContain(
        "@earendil-works/pi-coding-agent",
      );
      expect(code, `${name} must not import the Pi agent`).not.toContain(
        "@earendil-works/pi-agent",
      );
      expect(code, `${name} must not import Pi AI`).not.toContain("@earendil-works/pi-ai");
    }
  });

  it("permits ONLY @earendil-works/pi-tui among @earendil-works/* imports", () => {
    const piPackage = /@earendil-works\/([a-z0-9-]+)/g;
    for (const { name, code } of sources) {
      for (const match of code.matchAll(piPackage)) {
        expect(
          match[1],
          `${name} may import @earendil-works/pi-tui but not the Pi SDK (${match[0]})`,
        ).toBe("pi-tui");
      }
    }
  });

  it("does import pi-tui (a real pi-tui renderer, not a stub)", () => {
    expect(sources.some((file) => file.code.includes("@earendil-works/pi-tui"))).toBe(true);
  });
});
