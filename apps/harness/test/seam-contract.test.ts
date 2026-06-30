import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ENGINE_COMMAND_TYPES,
  ENGINE_EVENT_TYPES,
  isEngineCommand,
  isEngineEvent,
  PROGRESS_KINDS,
  RUN_FAILURE_CLASSES,
  type EngineCommand,
  type EngineEvent,
} from "../src/engine/seam";

// One structurally-valid instance of EVERY EngineEvent variant.
const SAMPLE_EVENTS: EngineEvent[] = [
  { type: "phase_changed", phase: "form", previous: "idle" },
  { type: "progress", kind: "tool_execution", detail: "git status" },
  { type: "form_requested", schema: { fields: ["product", "problem", "vision"] } },
  { type: "decision_requested", prompt: "Commit?", options: ["Commit", "Cancel"] },
  { type: "run_completed", artifacts: ["README.md"], decisions: 1 },
  { type: "run_failed", class: "internal", detail: "boom" },
];

// One structurally-valid instance of EVERY EngineCommand variant.
const SAMPLE_COMMANDS: EngineCommand[] = [
  { type: "start_run", cwd: "/abs/empty" },
  { type: "submit_form", values: { product: "SIBYL" } },
  { type: "submit_decision", choice: "Commit" },
  { type: "abort" },
];

describe("EngineEvent / EngineCommand contract (schema conformance)", () => {
  it("declares exactly the six EngineEvent and four EngineCommand discriminants", () => {
    expect([...ENGINE_EVENT_TYPES].sort()).toEqual(
      [
        "decision_requested",
        "form_requested",
        "phase_changed",
        "progress",
        "run_completed",
        "run_failed",
      ].sort(),
    );
    expect([...ENGINE_COMMAND_TYPES].sort()).toEqual(
      ["abort", "start_run", "submit_decision", "submit_form"].sort(),
    );
    expect([...PROGRESS_KINDS]).toEqual(["tool_execution", "message_update"]);
    expect([...RUN_FAILURE_CLASSES]).toEqual(["aborted", "agent", "tool", "protocol", "internal"]);
  });

  it("has a sample covering every declared discriminant (no orphan variants)", () => {
    expect(new Set(SAMPLE_EVENTS.map((event) => event.type))).toEqual(new Set(ENGINE_EVENT_TYPES));
    expect(new Set(SAMPLE_COMMANDS.map((command) => command.type))).toEqual(
      new Set(ENGINE_COMMAND_TYPES),
    );
  });

  it("accepts every valid EngineEvent and EngineCommand", () => {
    for (const event of SAMPLE_EVENTS) {
      expect(isEngineEvent(event)).toBe(true);
    }
    for (const command of SAMPLE_COMMANDS) {
      expect(isEngineCommand(command)).toBe(true);
    }
  });

  it("rejects malformed or cross-kind values", () => {
    const bad: unknown[] = [
      null,
      undefined,
      42,
      "phase_changed",
      {},
      { type: "unknown" },
      { type: "progress", kind: "bogus", detail: "x" },
      { type: "progress", kind: "tool_execution" }, // missing detail
      { type: "run_failed", class: "bogus", detail: "x" },
      { type: "form_requested", schema: { fields: [1, 2] } }, // non-string fields
      { type: "decision_requested", prompt: "?", options: "Commit" }, // options not an array
    ];
    for (const value of bad) {
      expect(isEngineEvent(value)).toBe(false);
    }

    // Cross-kind: a command is not an event and vice versa.
    expect(isEngineEvent({ type: "start_run", cwd: "/x" })).toBe(false);
    expect(isEngineCommand({ type: "phase_changed", phase: "form", previous: "idle" })).toBe(false);
    expect(isEngineCommand({ type: "submit_form", values: { a: 1 } })).toBe(false); // non-string value
    expect(isEngineCommand(null)).toBe(false);
  });
});

describe("ADR-001 invariant: NO ctx.ui / pi-tui in the engine", () => {
  // Strip comments so the scan inspects CODE, not documentation (this very file
  // and the engine JSDoc legitimately mention `ctx.ui` to explain the invariant).
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  const engineDir = fileURLToPath(new URL("../src/engine", import.meta.url));
  const sources = readdirSync(engineDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, code: stripComments(readFileSync(`${engineDir}/${name}`, "utf8")) }));

  it("reads the engine source files", () => {
    expect(sources.length).toBeGreaterThanOrEqual(4); // session, extension, seam, state-machine
  });

  it("contains no `ctx.ui` reference and no pi-tui import in any engine CODE", () => {
    for (const { name, code } of sources) {
      expect(code, `${name} must not reference ctx.ui`).not.toMatch(/\bctx\s*\.\s*ui\b/);
      expect(code, `${name} must not import pi-tui`).not.toContain("@earendil-works/pi-tui");
    }
  });

  it("keeps the seam + state machine PURE of any Pi import", () => {
    for (const name of ["seam.ts", "state-machine.ts"]) {
      const source = sources.find((file) => file.name === name);
      expect(source, `${name} should exist`).toBeDefined();
      expect(source?.code, `${name} must not import from @earendil-works/*`).not.toContain(
        "@earendil-works/",
      );
    }
  });
});
