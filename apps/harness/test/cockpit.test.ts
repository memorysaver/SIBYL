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
