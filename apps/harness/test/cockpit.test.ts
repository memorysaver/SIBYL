import { type Terminal, TUI, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import type { ConversationCommand } from "../src/engine/conversation";
import { Cockpit, COCKPIT_TABS } from "../src/renderer/cockpit";
import { createTheme } from "../src/renderer/theme";

/**
 * The cockpit renderer: a fixed layout whose primary tab area is the project
 * WYSIWYG and whose secondary chat panel drives it. Tested headlessly (fake
 * terminal, monochrome theme, injected artifact reader) — the live vibrant render
 * is human-verified in a real TTY.
 */

function headlessTerminal(rows = 24, columns = 100): Terminal {
  return {
    start: () => {},
    stop: () => {},
    drainInput: () => Promise.resolve(),
    write: () => {},
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
  };
}

const README = "# Task Tracker\n\n> Make what's next obvious.\n\n## Problem\n\nToo many tasks.\n";

describe("Cockpit — fixed layout, tab framework, chat driver", () => {
  it("renders every line to the exact width (borders align, no ghosting)", () => {
    const commands: ConversationCommand[] = [];
    const cockpit = new Cockpit({
      tui: new TUI(headlessTerminal()),
      theme: createTheme({ color: false }),
      project: "demo",
      dispatch: (command) => commands.push(command),
      readArtifact: (tab) => (tab === "goal" ? README : undefined),
    });
    for (const width of [80, 100, 120]) {
      for (const line of cockpit.render(width)) {
        expect(visibleWidth(line)).toBe(width);
      }
    }
  });

  it("shows the full tab framework with the active tab highlighted", () => {
    const commands: ConversationCommand[] = [];
    const cockpit = new Cockpit({
      tui: new TUI(headlessTerminal()),
      theme: createTheme({ color: false }),
      dispatch: (command) => commands.push(command),
      readArtifact: () => README,
    });
    const out = cockpit.render(100).join("\n");
    for (const tab of COCKPIT_TABS) {
      expect(out).toContain(tab.label);
    }
    expect(out).toContain("‹ Goal ›"); // Goal active by default
  });

  it("renders the Goal tab as the README (WYSIWYG) and switches tabs with Tab", () => {
    const commands: ConversationCommand[] = [];
    const cockpit = new Cockpit({
      tui: new TUI(headlessTerminal()),
      theme: createTheme({ color: false }),
      dispatch: (command) => commands.push(command),
      readArtifact: (tab) => (tab === "goal" ? README : undefined),
    });
    expect(cockpit.render(100).join("\n")).toContain("Task Tracker");

    cockpit.handleInput("\t"); // Goal → Story Map
    expect(cockpit.activeTab.id).toBe("story-map");
    expect(cockpit.render(100).join("\n")).toContain("Story Map");
    expect(cockpit.render(100).join("\n")).toContain("coming soon");
  });

  it("falls back to a prompt when there is no README yet", () => {
    const commands: ConversationCommand[] = [];
    const cockpit = new Cockpit({
      tui: new TUI(headlessTerminal()),
      theme: createTheme({ color: false }),
      dispatch: (command) => commands.push(command),
      readArtifact: () => undefined,
    });
    expect(cockpit.render(100).join("\n")).toContain("No README yet");
  });

  it("streams conversation events into the chat panel in order", () => {
    const commands: ConversationCommand[] = [];
    const cockpit = new Cockpit({
      tui: new TUI(headlessTerminal()),
      theme: createTheme({ color: false }),
      dispatch: (command) => commands.push(command),
      readArtifact: () => README,
    });
    cockpit.handle({ type: "user_echo", text: "hello there" });
    cockpit.handle({ type: "status", state: "streaming" });
    cockpit.handle({ type: "assistant_delta", text: "hi — what shall we build?" });
    cockpit.handle({
      type: "tool",
      name: "write",
      phase: "end",
      detail: "README.md",
      isError: false,
    });

    const out = cockpit.render(100).join("\n");
    expect(out).toContain("hello there");
    expect(out).toContain("hi — what shall we build?");
    expect(out).toContain("write README.md");
    expect(out).toContain("● thinking"); // streaming chip in the header
  });

  it("renders captured decisions on the Decisions tab instead of the placeholder", () => {
    const decisionsDoc =
      '# Decisions\n\n- [originate] Committed README.md — "docs: add project README"\n';
    const cockpit = new Cockpit({
      tui: new TUI(headlessTerminal()),
      theme: createTheme({ color: false }),
      dispatch: () => {},
      readArtifact: (tab) =>
        tab === "goal" ? README : tab === "decisions" ? decisionsDoc : undefined,
    });

    // The agent's commit fires an artifact change; the tab re-reads its log.
    cockpit.handle({ type: "artifact_changed", tab: "decisions" });

    // Goal → Story Map → Architecture → Decisions.
    cockpit.handleInput("\t");
    cockpit.handleInput("\t");
    cockpit.handleInput("\t");
    expect(cockpit.activeTab.id).toBe("decisions");

    const out = cockpit.render(100).join("\n");
    expect(out).toContain("Committed README.md");
    expect(out).not.toContain("decision-memory log will render here"); // placeholder gone
  });

  it("dispatches a send command when the user submits the chat input", () => {
    const commands: ConversationCommand[] = [];
    const cockpit = new Cockpit({
      tui: new TUI(headlessTerminal()),
      theme: createTheme({ color: false }),
      dispatch: (command) => commands.push(command),
      readArtifact: () => README,
    });
    cockpit.handleInput("build it");
    cockpit.handleInput("\r"); // Enter → submit
    expect(commands).toEqual([{ type: "send", text: "build it" }]);
  });

  it("invokes onQuit on Ctrl-C", () => {
    let quits = 0;
    const cockpit = new Cockpit({
      tui: new TUI(headlessTerminal()),
      theme: createTheme({ color: false }),
      dispatch: () => {},
      readArtifact: () => README,
      onQuit: () => {
        quits += 1;
      },
    });
    cockpit.handleInput("\x03");
    expect(quits).toBe(1);
  });
});

// ─── SIBYL-016: phase indicator + Architecture tab (envision output) ─────────

import { ARCHITECTURE_EMPTY_STATE } from "../src/renderer/cockpit";
import { serializeEnvisionYaml } from "../src/engine/submit";

/** A canonical envision artifact, produced by the REAL harness serializer. */
const FRAMING_YAML = serializeEnvisionYaml({
  problem: "Solo builders lose the thread between idea and shipped software.",
  personas: [{ name: "solo-aep-builder", description: "Builds products alone with agents." }],
  activities: [
    { id: "frame-product", name: "Frame the product", order: 2, layer_introduced: 1 },
    { id: "capture-idea", name: "Capture the idea", order: 1, layer_introduced: 0 },
  ],
  layers: [
    { layer: 0, name: "walking skeleton", user_can: "originate a committed README" },
    { layer: 1, name: "envision", user_can: "frame the product into product/index.yaml" },
  ],
  mvp_boundary: { in_scope: ["cockpit"], out_of_scope: ["multiplayer"] },
});

describe("Cockpit — phase indicator + Architecture tab (SIBYL-016)", () => {
  it("renders the reported phase in the header (visible phase indicator)", () => {
    const cockpit = new Cockpit({
      tui: new TUI(headlessTerminal()),
      theme: createTheme({ color: false }),
      project: "demo",
      dispatch: () => {},
      readArtifact: () => undefined,
    });
    expect(cockpit.render(100).join("\n")).not.toContain("[envision]");

    cockpit.handle({ type: "phase", phase: "envision" });
    const out = cockpit.render(100).join("\n");
    expect(out).toContain("[envision]");

    // Every line still renders to the exact width with the indicator present.
    for (const line of cockpit.render(100)) {
      expect(visibleWidth(line)).toBe(100);
    }
  });

  it("surfaces a phase NOTE (beyond-registry fallback) in the chat log", () => {
    const cockpit = new Cockpit({
      tui: new TUI(headlessTerminal()),
      theme: createTheme({ color: false }),
      dispatch: () => {},
      readArtifact: () => undefined,
    });
    cockpit.handle({
      type: "phase",
      phase: "envision",
      note: "Project artifacts are beyond the registered phases — falling back to envision.",
    });
    const out = cockpit.render(100).join("\n");
    expect(out).toContain("beyond the registered phases");
  });

  it("shows the Architecture empty state until product/index.yaml exists", () => {
    const cockpit = new Cockpit({
      tui: new TUI(headlessTerminal()),
      theme: createTheme({ color: false }),
      dispatch: () => {},
      readArtifact: (tab) => (tab === "goal" ? README : undefined),
    });
    cockpit.handleInput("\t"); // Goal → Story Map
    cockpit.handleInput("\t"); // Story Map → Architecture
    expect(cockpit.activeTab.id).toBe("architecture");
    const out = cockpit.render(100).join("\n");
    expect(out).toContain("No product/index.yaml yet");
    expect(out).toContain(ARCHITECTURE_EMPTY_STATE);
  });

  it("AC2: re-renders the framing (activities + layers) on artifact_changed — no restart", () => {
    let architecture: string | undefined; // starts absent (pre-submit)
    const cockpit = new Cockpit({
      tui: new TUI(headlessTerminal(30)),
      theme: createTheme({ color: false }),
      dispatch: () => {},
      readArtifact: (tab) =>
        tab === "goal" ? README : tab === "architecture" ? architecture : undefined,
    });
    cockpit.handleInput("\t");
    cockpit.handleInput("\t");
    expect(cockpit.activeTab.id).toBe("architecture");
    expect(cockpit.render(100).join("\n")).toContain("No product/index.yaml yet");

    // submit_envision completes: the harness wrote+committed the artifact and the
    // conversation fired artifact_changed{architecture} (hooks + adapter path).
    architecture = FRAMING_YAML;
    cockpit.handle({ type: "artifact_changed", tab: "architecture" });

    const out = cockpit.render(100).join("\n");
    // Problem one-liner.
    expect(out).toContain("Solo builders lose the thread");
    // Activities, sorted by backbone order, with their introduction layer.
    expect(out).toContain("1. Capture the idea — introduced L0");
    expect(out).toContain("2. Frame the product — introduced L1");
    expect(out.indexOf("1. Capture the idea")).toBeLessThan(out.indexOf("2. Frame the product"));
    // Layers with layer number, name, and what the user can do.
    expect(out).toContain("L0 walking skeleton — user can: originate a committed README");
    expect(out).toContain("L1 envision");
    // The empty state is gone.
    expect(out).not.toContain("No product/index.yaml yet");
  });

  it("falls back to a readable preformatted view for unparseable YAML (never crashes)", () => {
    const cockpit = new Cockpit({
      tui: new TUI(headlessTerminal()),
      theme: createTheme({ color: false }),
      dispatch: () => {},
      readArtifact: (tab) =>
        tab === "architecture" ? "::: not yaml at all\n\t{unbalanced" : undefined,
    });
    cockpit.handle({ type: "artifact_changed", tab: "architecture" });
    cockpit.handleInput("\t");
    cockpit.handleInput("\t");
    const out = cockpit.render(100).join("\n");
    expect(out).toContain("::: not yaml at all");
  });
});
