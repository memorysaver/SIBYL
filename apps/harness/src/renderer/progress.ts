/**
 * Live progress widget (SIBYL-006).
 *
 * Renders the `agent_run.progress_log` secondary attribute (Object Map slice
 * `agent_run`) — the stream of live activity the engine emits while a run
 * executes: tool steps (`progress.kind === "tool_execution"`) and streaming
 * assistant/thinking text (`progress.kind === "message_update"`).
 *
 * This file is part of the RENDERER. It consumes ONLY the seam's `ProgressKind`
 * (a structural type) and the `@earendil-works/pi-tui` UI library. It does NOT
 * import the Pi SDK / agent (`@earendil-works/pi-coding-agent` / `pi-agent`):
 * progress arrives exclusively as `EngineEvent`s.
 *
 * The model ({@link ProgressLog}) is pure (no pi-tui, no TTY) so the render
 * logic is unit-testable headlessly; {@link ProgressWidget} is a pi-tui
 * `Component` whose `render(width)` is likewise pure (no terminal needed — only
 * the `TUI` mount in `app.ts` touches a real TTY).
 */

import { Box, Text, type Component } from "@earendil-works/pi-tui";

import type { ProgressKind } from "../engine/seam";

/** A single progress line in the log (mirrors a seam `progress` event payload). */
export interface ProgressEntry {
  readonly kind: ProgressKind;
  readonly detail: string;
}

/** Human label per {@link ProgressKind}, used to prefix a rendered line. */
const KIND_LABEL: Readonly<Record<ProgressKind, string>> = {
  tool_execution: "tool",
  message_update: "text",
};

/** Format one entry into a display line, e.g. `[tool] git status --porcelain`. */
export function formatProgressLine(entry: ProgressEntry): string {
  return `[${KIND_LABEL[entry.kind]}] ${entry.detail}`;
}

/**
 * Append-only progress model. Pure: no pi-tui, no TTY, no Pi SDK. The widget
 * renders FROM this; tests assert against it directly.
 */
export class ProgressLog {
  readonly #entries: ProgressEntry[] = [];

  /** Append a progress entry (copied so callers cannot mutate stored state). */
  append(entry: ProgressEntry): void {
    this.#entries.push({ kind: entry.kind, detail: entry.detail });
  }

  /** The entries in arrival order. */
  get entries(): readonly ProgressEntry[] {
    return this.#entries;
  }

  /** Number of entries logged so far. */
  get size(): number {
    return this.#entries.length;
  }

  /** The formatted display lines, one per entry. */
  lines(): string[] {
    return this.#entries.map(formatProgressLine);
  }

  /** Drop all entries (e.g. when a fresh run starts). */
  clear(): void {
    this.#entries.length = 0;
  }
}

/**
 * A pi-tui {@link Component} that renders a {@link ProgressLog}: one `Text` line
 * per entry inside a `Box`, or the empty-state line when nothing has streamed
 * yet. `render(width)` re-syncs the box from the (mutable) log each frame, so
 * appending to the log + re-rendering reflects new activity with no extra
 * wiring. Pure — no TTY required.
 */
export class ProgressWidget implements Component {
  readonly #log: ProgressLog;
  readonly #emptyState: string;
  readonly #box = new Box(0, 0);

  constructor(log: ProgressLog, emptyState = "No activity yet") {
    this.#log = log;
    this.#emptyState = emptyState;
  }

  /** Invalidate cached rendering (theme change / forced re-render). */
  invalidate(): void {
    this.#box.invalidate();
  }

  /** Render the current log to lines for the given viewport width. */
  render(width: number): string[] {
    this.#box.clear();
    const lines = this.#log.lines();
    if (lines.length === 0) {
      this.#box.addChild(new Text(this.#emptyState));
    } else {
      for (const line of lines) {
        this.#box.addChild(new Text(line));
      }
    }
    return this.#box.render(width);
  }
}
