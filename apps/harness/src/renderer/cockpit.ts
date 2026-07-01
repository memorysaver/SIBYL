/**
 * The SIBYL project cockpit (renderer).
 *
 * A fixed, lazygit-style layout whose PRIMARY area is the project itself — a tab
 * bar (Goal / Story Map / Architecture / Decisions) rendering the project's
 * artifacts WYSIWYG — and whose SECONDARY area is a chat panel that is the sole
 * driver: you talk to a real (Codex-backed) agent, the agent edits the artifacts,
 * and the active tab re-renders live.
 *
 * Part of the RENDERER: it imports only `@earendil-works/pi-tui` among `@earendil`
 * packages (the `renderer-no-pi-sdk` scan stays green) and consumes the
 * conversation seam as TYPES only (`ConversationEvent` / `ConversationCommand`) —
 * never the Pi SDK (ADR-001). It reads artifact text through an injected
 * `readArtifact` port, so it renders headlessly for tests (no fs, no TTY).
 */

import {
  type Component,
  Input,
  Markdown,
  truncateToWidth,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";

import type { ArtifactTab, ConversationCommand, ConversationEvent } from "../engine/conversation";
import { padTo, Panel } from "./panel";
import { createTheme, markdownTheme, type Theme } from "./theme";

/** A cockpit tab: an artifact id + its display label. */
export interface CockpitTab {
  readonly id: ArtifactTab;
  readonly label: string;
}

/** The fixed tab set (framework complete; only Goal is wired to real content in v1). */
export const COCKPIT_TABS: readonly CockpitTab[] = [
  { id: "goal", label: "Goal" },
  { id: "story-map", label: "Story Map" },
  { id: "architecture", label: "Architecture" },
  { id: "decisions", label: "Decisions" },
];

/** Placeholder copy for the not-yet-wired tabs. */
const TAB_PLACEHOLDER: Record<Exclude<ArtifactTab, "goal">, string> = {
  "story-map": "Story Map — the AEP story graph / object map will render here.",
  architecture: "Architecture — the system map from product-context.yaml will render here.",
  decisions: "Decisions — the decision-memory log will render here.",
};

/** A chat entry in arrival order (interleaves user / assistant / tool / error). */
interface ChatEntry {
  kind: "user" | "assistant" | "tool" | "error";
  text: string;
  done?: boolean;
  toolPhase?: "start" | "end";
  isError?: boolean;
}

/** Reads the current text of an artifact tab (e.g. `README.md` for `goal`). */
export type ReadArtifact = (tab: ArtifactTab) => string | undefined;

/** Construction dependencies for {@link Cockpit}. */
export interface CockpitDeps {
  readonly tui: TUI;
  readonly theme?: Theme;
  /** Header label for the project (e.g. the cwd basename). */
  readonly project?: string;
  /** Send a command into the conversation (chat is the sole driver). */
  readonly dispatch: (command: ConversationCommand) => void;
  /** Read an artifact's current text (injected so the renderer stays fs-free). */
  readonly readArtifact: ReadArtifact;
  /** Invoked on Ctrl-C so the mount can tear down + exit. */
  readonly onQuit?: () => void;
}

/** A trivial Component wrapping fixed pre-rendered lines (framed by a {@link Panel}). */
class FixedLines implements Component {
  #lines: readonly string[];
  constructor(lines: readonly string[]) {
    this.#lines = lines;
  }
  setLines(lines: readonly string[]): void {
    this.#lines = lines;
  }
  invalidate(): void {}
  render(): string[] {
    return [...this.#lines];
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Clip `lines` to `height` and pad with blanks so the result is exactly `height`. */
function fitLines(lines: readonly string[], height: number): string[] {
  const clipped = lines.slice(0, height);
  while (clipped.length < height) {
    clipped.push("");
  }
  return clipped;
}

/**
 * The cockpit. It is the single FOCUSED component (it owns keyboard input):
 * printable keys go to the embedded chat {@link Input}; `Tab` / `Shift-Tab` switch
 * the active tab. Feed it {@link ConversationEvent}s via {@link handle}; it renders
 * a full-screen header + primary tab panel + chat panel + footer.
 */
export class Cockpit implements Component {
  /** Set by the TUI when focused — the cockpit owns all keyboard input. */
  focused = false;

  readonly #theme: Theme;
  readonly #tui: TUI;
  readonly #project: string;
  readonly #dispatch: (command: ConversationCommand) => void;
  readonly #readArtifact: ReadArtifact;
  readonly #onQuit: (() => void) | undefined;

  readonly #input = new Input();
  readonly #primaryPanel: Panel;
  readonly #primaryChild = new FixedLines([]);
  readonly #chatPanel: Panel;
  readonly #chatChild = new FixedLines([]);
  readonly #goalMarkdown: Markdown;

  #tabIndex = 0;
  #entries: ChatEntry[] = [];
  #openAssistant = false;
  #status: "idle" | "streaming" = "idle";
  #goalContent: string | undefined;

  constructor(deps: CockpitDeps) {
    this.#theme = deps.theme ?? createTheme();
    this.#tui = deps.tui;
    this.#project = deps.project ?? "project";
    this.#dispatch = deps.dispatch;
    this.#readArtifact = deps.readArtifact;
    this.#onQuit = deps.onQuit;

    this.#input.focused = true;
    this.#input.onSubmit = (value) => {
      this.#onSubmit(value);
    };

    this.#goalMarkdown = new Markdown("", 0, 0, markdownTheme(this.#theme));
    this.#primaryPanel = new Panel({ theme: this.#theme, padX: 1, focused: true });
    this.#primaryPanel.setChild(this.#primaryChild);
    this.#chatPanel = new Panel({ theme: this.#theme, padX: 1, title: "chat" });
    this.#chatPanel.setChild(this.#chatChild);

    this.#refreshArtifact("goal");
  }

  /** The currently active tab. */
  get activeTab(): CockpitTab {
    return COCKPIT_TABS[this.#tabIndex] ?? COCKPIT_TABS[0]!;
  }

  /** The chat entries so far (for tests). */
  get entries(): readonly ChatEntry[] {
    return this.#entries;
  }

  /** Apply one conversation event: update chat / status / artifacts. */
  handle(event: ConversationEvent): void {
    switch (event.type) {
      case "user_echo":
        this.#closeAssistant();
        this.#entries.push({ kind: "user", text: event.text });
        break;
      case "assistant_delta":
        this.#appendAssistant(event.text);
        break;
      case "assistant_done":
        this.#closeAssistant();
        break;
      case "tool":
        this.#handleTool(event.name, event.phase, event.detail, event.isError === true);
        break;
      case "artifact_changed":
        this.#refreshArtifact(event.tab);
        break;
      case "status":
        this.#status = event.state;
        break;
      case "error":
        this.#closeAssistant();
        this.#entries.push({ kind: "error", text: event.detail });
        break;
      default:
        break;
    }
  }

  /** Route keyboard input: Ctrl-C quits; Tab cycles tabs; else edits the chat input. */
  handleInput(data: string): void {
    if (data === "\x03") {
      this.#onQuit?.();
      return;
    }
    if (data === "\t") {
      this.#tabIndex = (this.#tabIndex + 1) % COCKPIT_TABS.length;
    } else if (data === "\x1b[Z") {
      this.#tabIndex = (this.#tabIndex - 1 + COCKPIT_TABS.length) % COCKPIT_TABS.length;
    } else {
      this.#input.handleInput(data);
    }
    this.#tui.requestRender();
  }

  invalidate(): void {
    this.#goalMarkdown.invalidate();
  }

  // -- input / chat model ---------------------------------------------------

  #onSubmit(value: string): void {
    const text = value.trim();
    this.#input.setValue("");
    if (text.length === 0) {
      return;
    }
    this.#dispatch({ type: "send", text });
  }

  #appendAssistant(delta: string): void {
    const last = this.#entries.at(-1);
    if (this.#openAssistant && last?.kind === "assistant") {
      last.text += delta;
      return;
    }
    this.#entries.push({ kind: "assistant", text: delta, done: false });
    this.#openAssistant = true;
  }

  #closeAssistant(): void {
    if (this.#openAssistant) {
      const last = this.#entries.at(-1);
      if (last?.kind === "assistant") {
        last.done = true;
      }
      this.#openAssistant = false;
    }
  }

  #handleTool(name: string, phase: "start" | "end", detail: string, isError: boolean): void {
    this.#closeAssistant();
    const text = detail ? `${name} ${detail}` : name;
    if (phase === "start") {
      this.#entries.push({ kind: "tool", text, toolPhase: "start" });
      return;
    }
    // Mark the most recent matching start as ended (or append a fresh end line).
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const entry = this.#entries[i]!;
      if (entry.kind === "tool" && entry.toolPhase === "start" && entry.text === text) {
        entry.toolPhase = "end";
        entry.isError = isError;
        return;
      }
    }
    this.#entries.push({ kind: "tool", text, toolPhase: "end", isError });
  }

  #refreshArtifact(tab: ArtifactTab): void {
    if (tab === "goal") {
      this.#goalContent = this.#readArtifact("goal");
      this.#goalMarkdown.setText(this.#goalContent ?? "");
    }
  }

  // -- rendering ------------------------------------------------------------

  render(width: number): string[] {
    const w = Math.max(2, width);
    const rows = this.#terminalRows();
    const innerWidth = Math.max(1, w - 4); // Panel padX=1 ⇒ 2 border + 2 padding

    const header = padTo(this.#renderHeader(w), w);
    const footer = padTo(this.#renderFooter(w), w);

    const avail = Math.max(6, rows - 2);
    const chatH = clamp(Math.floor(avail * 0.38), 8, 16);
    const primaryH = Math.max(5, avail - chatH);

    // Primary panel: first inner line is the tab bar, the rest the active artifact.
    const primaryInner = Math.max(1, primaryH - 2);
    const tabBar = this.#renderTabBar(innerWidth);
    const tabBody = this.#renderTab(this.activeTab, innerWidth, Math.max(1, primaryInner - 1));
    // The tab bar (first inner line) is the primary panel's header — no border title.
    this.#primaryChild.setLines(fitLines([tabBar, ...tabBody], primaryInner));
    const primaryLines = this.#primaryPanel.render(w);

    // Chat panel: log tail + the input line, sized to fill its slice.
    const chatInner = Math.max(2, chatH - 2);
    this.#chatChild.setLines(this.#renderChat(innerWidth, chatInner));
    const chatLines = this.#chatPanel.render(w);

    return [header, ...primaryLines, ...chatLines, footer].map((line) => padTo(line, w));
  }

  #terminalRows(): number {
    const rows = this.#tui.terminal.rows;
    return Number.isFinite(rows) && rows > 0 ? rows : 24;
  }

  #renderHeader(width: number): string {
    const t = this.#theme;
    const left = ` ${t.title("SIBYL")} ${t.muted(`· ${this.#project}`)}`;
    const chip = this.#status === "streaming" ? t.warning("● thinking") : t.muted("○ ready");
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(chip) - 1);
    return `${left}${" ".repeat(gap)}${chip} `;
  }

  #renderFooter(width: number): string {
    return padTo(` ${this.#theme.muted("Tab switch tab · Enter send · Ctrl-C quit")}`, width);
  }

  #renderTabBar(innerWidth: number): string {
    const t = this.#theme;
    const parts = COCKPIT_TABS.map((tab, index) =>
      index === this.#tabIndex ? t.accent(`‹ ${tab.label} ›`) : t.muted(`  ${tab.label}  `),
    );
    return truncateToWidth(parts.join(" "), innerWidth);
  }

  #renderTab(tab: CockpitTab, innerWidth: number, height: number): string[] {
    const t = this.#theme;
    if (tab.id === "goal") {
      if (!this.#goalContent || this.#goalContent.trim().length === 0) {
        return fitLines(
          [t.muted("No README yet — tell the agent below what you want to build.")],
          height,
        );
      }
      return fitLines(this.#goalMarkdown.render(innerWidth), height);
    }
    const stub = TAB_PLACEHOLDER[tab.id];
    return fitLines([t.muted(stub), "", t.dim("(coming soon)")], height);
  }

  #renderChat(innerWidth: number, height: number): string[] {
    const logHeight = Math.max(1, height - 1);
    const logLines: string[] = [];
    for (const entry of this.#entries) {
      for (const line of this.#entryLines(entry, innerWidth)) {
        logLines.push(line);
      }
    }
    const body = fitLines(logLines.slice(-logHeight), logHeight);

    // The Input renders its own "> " prompt + cursor; don't double it.
    const rendered = this.#input.render(innerWidth);
    return [...body, rendered[0] ?? ""];
  }

  #entryLines(entry: ChatEntry, width: number): string[] {
    const t = this.#theme;
    switch (entry.kind) {
      case "user":
        return wrap(`you  ${entry.text}`, width).map((line, index) =>
          index === 0 ? t.accent(line) : line,
        );
      case "assistant": {
        const suffix = entry.done ? "" : " ▍";
        return wrap(`pi   ${entry.text}${suffix}`, width);
      }
      case "tool": {
        const glyph = entry.toolPhase === "end" ? (entry.isError ? "✗" : "✓") : "⚙";
        const styled = entry.isError ? t.error : t.muted;
        return [styled(truncateToWidth(`  ${glyph} ${entry.text}`, width))];
      }
      case "error":
        return wrap(`  ✗ ${entry.text}`, width).map((line) => t.error(line));
      default:
        return [];
    }
  }
}

/** Word-wrap plain text to `width` without relying on ANSI-aware wrapping. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (word.length === 0) {
        continue;
      }
      if (line.length === 0) {
        line = word;
      } else if (visibleWidth(`${line} ${word}`) <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out.map((line) => truncateToWidth(line, width));
}
