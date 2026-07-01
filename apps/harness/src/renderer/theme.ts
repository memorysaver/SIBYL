/**
 * Renderer theming (Layer-0.5 visual-design / ux-flow calibration).
 *
 * Part of the RENDERER. It imports ONLY types from `@earendil-works/pi-tui`
 * (so the `renderer-no-pi-sdk` source scan stays green) and reads `process.env`.
 * ANSI is HAND-ROLLED: `chalk` is NOT a harness dependency (it is only a hoisted
 * transitive devDependency of pi-tui), so importing it would break under stricter
 * installers — see `docs/decisions` ADR-002 (build-on-Pi-never-fork).
 *
 * The palette is "vibrant" (truecolor accents with 16-color fallbacks) but
 * DEGRADES SAFELY: when color is disabled (`NO_COLOR` set, or stdout is not a TTY
 * and `FORCE_COLOR` is unset) every palette slot is the identity `(t) => t`, so
 * headless renders — and the existing substring tests — see plain text.
 */

import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

/** A text-styling function: wraps `text` in ANSI (or returns it unchanged). */
export type StyleFn = (text: string) => string;

const RESET = "\x1b[0m";

/** Build a {@link StyleFn} for a `;`-joined SGR code list (no-op on empty text). */
function sgr(codes: string): StyleFn {
  const open = `\x1b[${codes}m`;
  return (text) => (text.length === 0 ? text : `${open}${text}${RESET}`);
}

/** The semantic palette the renderer styles against. Every slot is a {@link StyleFn}. */
export interface Theme {
  /** True when this theme emits ANSI (false ⇒ every slot is the identity). */
  readonly color: boolean;
  readonly title: StyleFn;
  readonly accent: StyleFn;
  readonly muted: StyleFn;
  readonly success: StyleFn;
  readonly error: StyleFn;
  readonly warning: StyleFn;
  readonly border: StyleFn;
  readonly focusedBorder: StyleFn;
  readonly selection: StyleFn;
  readonly bold: StyleFn;
  readonly dim: StyleFn;
}

/** Options for {@link createTheme}. */
export interface ThemeOptions {
  /** Force color on/off. Default: {@link colorEnabled}. */
  color?: boolean;
  /** Terminal scheme (affects muted/border contrast). Default: `"dark"`. */
  scheme?: "dark" | "light";
  /** Force truecolor on/off. Default: {@link truecolorEnabled}. */
  truecolor?: boolean;
}

const IDENTITY: StyleFn = (text) => text;

/** True when ANSI color should be emitted (`NO_COLOR` off; a TTY or `FORCE_COLOR`). */
export function colorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if ("NO_COLOR" in env) {
    return false;
  }
  const force = env.FORCE_COLOR;
  if (force != null && force !== "0" && force !== "false") {
    return true;
  }
  return Boolean(process.stdout?.isTTY);
}

/** True when the terminal advertises 24-bit color (`COLORTERM=truecolor|24bit`). */
export function truecolorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const colorterm = env.COLORTERM;
  return colorterm === "truecolor" || colorterm === "24bit";
}

type Rgb = readonly [number, number, number];

/** SGR codes for a foreground color (truecolor or 16-color fallback) plus `extra` codes. */
function fg(rgb: Rgb, basic: number, truecolor: boolean, ...extra: number[]): string {
  const colorCode = truecolor ? `38;2;${rgb[0]};${rgb[1]};${rgb[2]}` : String(basic);
  return [colorCode, ...extra.map(String)].join(";");
}

/**
 * Build a {@link Theme}. With color disabled (the default in non-TTY/headless and
 * under `NO_COLOR`), every slot is the identity so output is plain text. With
 * color enabled, a vibrant palette — violet title, cyan accents, semantic
 * green/red/amber — rendered in truecolor when available, else 16-color.
 */
export function createTheme(options: ThemeOptions = {}): Theme {
  const color = options.color ?? colorEnabled();
  if (!color) {
    return {
      color: false,
      title: IDENTITY,
      accent: IDENTITY,
      muted: IDENTITY,
      success: IDENTITY,
      error: IDENTITY,
      warning: IDENTITY,
      border: IDENTITY,
      focusedBorder: IDENTITY,
      selection: IDENTITY,
      bold: IDENTITY,
      dim: IDENTITY,
    };
  }

  const tc = options.truecolor ?? truecolorEnabled();
  const light = options.scheme === "light";

  const violet: Rgb = [167, 139, 250];
  const cyan: Rgb = [56, 189, 248];
  const muted: Rgb = light ? [71, 85, 105] : [148, 163, 184];
  const borderRgb: Rgb = light ? [148, 163, 184] : [71, 85, 105];
  const green: Rgb = [74, 222, 128];
  const red: Rgb = [248, 113, 113];
  const amber: Rgb = [251, 191, 36];

  return {
    color: true,
    title: sgr(fg(violet, 95, tc, 1)), // bold violet
    accent: sgr(fg(cyan, 96, tc)), // bright cyan
    muted: sgr(fg(muted, 90, tc)), // gray
    success: sgr(fg(green, 92, tc)),
    error: sgr(fg(red, 91, tc)),
    warning: sgr(fg(amber, 93, tc)),
    border: sgr(fg(borderRgb, 90, tc)),
    focusedBorder: sgr(fg(cyan, 96, tc, 1)), // bold bright cyan
    selection: sgr(fg(cyan, 96, tc, 1)), // bold bright cyan
    bold: sgr("1"),
    dim: sgr("2"),
  };
}

/** Adapter: a pi-tui {@link SelectListTheme} styled from a {@link Theme}. */
export function selectListTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: theme.accent,
    selectedText: theme.selection,
    description: theme.muted,
    scrollInfo: theme.muted,
    noMatch: theme.muted,
  };
}

/** Adapter: a pi-tui {@link EditorTheme} styled from a {@link Theme}. */
export function editorTheme(theme: Theme): EditorTheme {
  return { borderColor: theme.focusedBorder, selectList: selectListTheme(theme) };
}

const IDENTITY_STYLE: StyleFn = (text) => text;

/**
 * Adapter: a pi-tui {@link MarkdownTheme} styled from a {@link Theme} — used by
 * the cockpit's Goal tab to render `README.md` WYSIWYG. All required slots are
 * filled; `italic` approximates with dim, and strikethrough/underline are plain.
 */
export function markdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: theme.title,
    link: theme.accent,
    linkUrl: theme.muted,
    code: theme.accent,
    codeBlock: theme.muted,
    codeBlockBorder: theme.border,
    quote: theme.muted,
    quoteBorder: theme.border,
    hr: theme.muted,
    listBullet: theme.accent,
    bold: theme.bold,
    italic: theme.dim,
    strikethrough: IDENTITY_STYLE,
    underline: IDENTITY_STYLE,
  };
}
