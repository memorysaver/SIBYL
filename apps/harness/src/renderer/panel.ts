/**
 * `Panel` — a bordered, titled "window" card (Layer-0.5 visual-design).
 *
 * Part of the RENDERER: imports ONLY `@earendil-works/pi-tui` (the
 * `renderer-no-pi-sdk` scan stays green). pi-tui has no native border component,
 * so this hand-draws a box with box-drawing glyphs around a single child's
 * rendered lines, giving the modal-form flow its "window" feel without forking
 * Pi (ADR-002).
 *
 * Render invariant: EVERY returned line has `visibleWidth(line) === width` — the
 * borders align and old content is overwritten on phase/size changes (no ghosting).
 */

import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { createTheme, type Theme } from "./theme";

const TOP_LEFT = "┌";
const TOP_RIGHT = "┐";
const BOTTOM_LEFT = "└";
const BOTTOM_RIGHT = "┘";
const HORIZONTAL = "─";
const VERTICAL = "│";

/**
 * Pad (or ANSI-safe-truncate) `line` to exactly `width` visible columns. Used to
 * align body rows inside the border; preserves embedded ANSI / cursor markers for
 * normal-width content (only truncates when the line genuinely overflows).
 */
export function padTo(line: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  const truncated = truncateToWidth(line, width);
  const visible = visibleWidth(truncated);
  return visible < width ? truncated + " ".repeat(width - visible) : truncated;
}

/** Options for {@link Panel}. */
export interface PanelOptions {
  title?: string;
  theme?: Theme;
  /** Horizontal padding inside the border (default 1). */
  padX?: number;
  /** Vertical padding inside the border (default 0). */
  padY?: number;
  /** When true, the border uses the theme's focused color. */
  focused?: boolean;
}

/**
 * A pi-tui {@link Component} that frames a single child with a titled border.
 * `setChild` / `setTitle` / `setFocused` let one instance be reused across the
 * shell's phase screens. `render(width)` is pure (no TTY).
 */
export class Panel implements Component {
  #title: string;
  #theme: Theme;
  readonly #padX: number;
  readonly #padY: number;
  #focused: boolean;
  #child: Component | undefined;

  constructor(options: PanelOptions = {}) {
    this.#title = options.title ?? "";
    this.#theme = options.theme ?? createTheme();
    this.#padX = options.padX ?? 1;
    this.#padY = options.padY ?? 0;
    this.#focused = options.focused ?? false;
  }

  setTitle(title: string): void {
    this.#title = title;
  }

  setChild(child: Component | undefined): void {
    this.#child = child;
  }

  setFocused(focused: boolean): void {
    this.#focused = focused;
  }

  invalidate(): void {
    this.#child?.invalidate?.();
  }

  render(width: number): string[] {
    const w = Math.max(2, width);
    const borderFn = this.#focused ? this.#theme.focusedBorder : this.#theme.border;
    const innerWidth = Math.max(1, w - 2 - this.#padX * 2);
    const padding = " ".repeat(this.#padX);

    const bodyLines: string[] = [];
    for (let i = 0; i < this.#padY; i++) {
      bodyLines.push("");
    }
    if (this.#child) {
      for (const line of this.#child.render(innerWidth)) {
        bodyLines.push(line);
      }
    }
    for (let i = 0; i < this.#padY; i++) {
      bodyLines.push("");
    }

    const rows = bodyLines.map(
      (line) =>
        borderFn(VERTICAL) + padding + padTo(line, innerWidth) + padding + borderFn(VERTICAL),
    );

    return [this.#renderTop(w, borderFn), ...rows, this.#renderBottom(w, borderFn)];
  }

  /** `┌─ title ─…─┐` — title styled, dashes filling the rest. */
  #renderTop(width: number, borderFn: StyleFnLike): string {
    const span = width - 2; // visible columns between the corners
    if (this.#title.length === 0 || span < 6) {
      return borderFn(TOP_LEFT + HORIZONTAL.repeat(Math.max(0, span)) + TOP_RIGHT);
    }
    const title = truncateToWidth(this.#title, span - 4);
    const titleWidth = visibleWidth(title);
    const trailing = Math.max(0, span - 3 - titleWidth); // "─ " (2) + title + " " (1)
    const middle =
      borderFn(`${HORIZONTAL} `) +
      this.#theme.title(title) +
      borderFn(` ${HORIZONTAL.repeat(trailing)}`);
    return borderFn(TOP_LEFT) + middle + borderFn(TOP_RIGHT);
  }

  #renderBottom(width: number, borderFn: StyleFnLike): string {
    return borderFn(BOTTOM_LEFT + HORIZONTAL.repeat(Math.max(0, width - 2)) + BOTTOM_RIGHT);
  }
}

/** Local alias so the private border helpers stay readable. */
type StyleFnLike = (text: string) => string;
