import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { colorEnabled, createTheme, editorTheme, selectListTheme } from "../src/renderer/theme";

/**
 * Layer-0.5 visual-design: the theme is VIBRANT when color is on but DEGRADES to
 * plain text when it is off (NO_COLOR / non-TTY). The monochrome default is what
 * keeps the headless renderer + existing substring tests green.
 */

describe("theme — monochrome safety", () => {
  it("color:false makes every palette slot the identity", () => {
    const t = createTheme({ color: false });
    expect(t.color).toBe(false);
    const slots = [
      t.title,
      t.accent,
      t.muted,
      t.success,
      t.error,
      t.warning,
      t.border,
      t.focusedBorder,
      t.selection,
      t.bold,
      t.dim,
    ];
    for (const slot of slots) {
      expect(slot("sample")).toBe("sample");
    }
  });

  it("colorEnabled honors NO_COLOR / FORCE_COLOR (NO_COLOR wins)", () => {
    expect(colorEnabled({ NO_COLOR: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(colorEnabled({ FORCE_COLOR: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(colorEnabled({ FORCE_COLOR: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(colorEnabled({ NO_COLOR: "1", FORCE_COLOR: "1" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("theme — color output", () => {
  it("wraps text in ANSI that resets and adds NO visible width", () => {
    const t = createTheme({ color: true });
    const styled = t.accent("Commit");
    expect(styled).toContain("\x1b[");
    expect(styled.endsWith("\x1b[0m")).toBe(true);
    expect(styled).toContain("Commit");
    expect(visibleWidth(styled)).toBe(visibleWidth("Commit"));
  });

  it("never wraps an empty string (blank lines stay blank)", () => {
    const t = createTheme({ color: true });
    expect(t.muted("")).toBe("");
    expect(t.title("")).toBe("");
  });

  it("uses 24-bit SGR with truecolor, 16-color codes without", () => {
    expect(createTheme({ color: true, truecolor: true }).accent("x")).toContain("38;2;");
    expect(createTheme({ color: true, truecolor: false }).accent("x")).toContain("\x1b[96m");
  });

  it("adapters style the pi-tui SelectList / Editor theme slots", () => {
    const t = createTheme({ color: true });
    expect(selectListTheme(t).selectedText("Commit")).toContain("\x1b[");
    const editor = editorTheme(t);
    expect(editor.borderColor("│")).toContain("\x1b[");
    expect(editor.selectList.description("hint")).toContain("\x1b[");
  });
});
