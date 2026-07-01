import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { padTo, Panel } from "../src/renderer/panel";
import { createTheme } from "../src/renderer/theme";

/**
 * Layer-0.5 visual-design: the `Panel` gives the modal-form flow its "window"
 * card. Its load-bearing invariant is that EVERY rendered line is exactly `width`
 * visible columns wide — borders align and content never overflows, so phase /
 * resize changes leave no ghosting.
 */

/** A trivial child that renders fixed lines (ignores width). */
class FixedChild implements Component {
  readonly #lines: readonly string[];
  constructor(lines: readonly string[]) {
    this.#lines = lines;
  }
  invalidate(): void {}
  render(): string[] {
    return [...this.#lines];
  }
}

describe("padTo", () => {
  it("pads short lines, is a no-op at exact width, and truncates overflow", () => {
    expect(padTo("hi", 5)).toBe("hi   ");
    expect(visibleWidth(padTo("hi", 5))).toBe(5);
    expect(padTo("hello", 5)).toBe("hello");
    expect(visibleWidth(padTo("hello world", 5))).toBe(5);
  });
});

describe("Panel", () => {
  const theme = createTheme({ color: false });

  it("frames the child; every line is exactly `width` wide across sizes", () => {
    const panel = new Panel({ title: "vision", theme, padX: 2, padY: 1 });
    panel.setChild(new FixedChild(["line one", "line two"]));

    for (const width of [20, 40, 64, 80]) {
      const lines = panel.render(width);
      for (const line of lines) {
        expect(visibleWidth(line)).toBe(width);
      }
      expect(lines[0]?.startsWith("┌")).toBe(true);
      expect(lines[0]).toContain("vision"); // title embedded in the top border
      expect(lines.at(-1)?.startsWith("└")).toBe(true);
      expect(lines.join("\n")).toContain("line one");
    }
  });

  it("holds the width invariant whether focused or not", () => {
    const panel = new Panel({ title: "t", theme });
    panel.setChild(new FixedChild(["x"]));
    for (const focused of [true, false]) {
      panel.setFocused(focused);
      for (const line of panel.render(30)) {
        expect(visibleWidth(line)).toBe(30);
      }
    }
  });

  it("renders a title-less border that still holds the invariant", () => {
    const panel = new Panel({ theme });
    panel.setChild(new FixedChild(["body"]));
    for (const line of panel.render(24)) {
      expect(visibleWidth(line)).toBe(24);
    }
  });
});
