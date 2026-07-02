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
import { parse as parseYaml } from "yaml";

import type { ArtifactTab, ConversationCommand, ConversationEvent } from "../engine/conversation";
import { padTo, Panel } from "./panel";
import { createTheme, markdownTheme, type Theme } from "./theme";

/** A cockpit tab: an artifact id + its display label. */
export interface CockpitTab {
  readonly id: ArtifactTab;
  readonly label: string;
}

/** The fixed tab set (Goal, Architecture and Decisions render real artifacts; Story Map is L2+). */
export const COCKPIT_TABS: readonly CockpitTab[] = [
  { id: "goal", label: "Goal" },
  { id: "story-map", label: "Story Map" },
  { id: "architecture", label: "Architecture" },
  { id: "decisions", label: "Decisions" },
];

/** Placeholder copy for the not-yet-wired tabs. */
const TAB_PLACEHOLDER: Record<Exclude<ArtifactTab, "goal" | "architecture">, string> = {
  "story-map": "Story Map — the AEP story graph / object map will render here.",
  decisions: "Decisions — the decision-memory log will render here.",
};

/**
 * The Architecture tab's empty state (SIBYL-016): shown until the envision
 * phase completes and the harness writes `product/index.yaml`.
 */
export const ARCHITECTURE_EMPTY_STATE =
  "No product/index.yaml yet — complete the envision phase to frame the product.";

/** A chat entry in arrival order (interleaves user / assistant / tool / info / error). */
interface ChatEntry {
  kind: "user" | "assistant" | "tool" | "info" | "error";
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
  /** The AEP phase the conversation reported (`phase` event) — shown in the header. */
  #phase: string | undefined;
  #goalContent: string | undefined;
  #architectureContent: string | undefined;
  #decisionsContent: string | undefined;

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
    this.#refreshArtifact("architecture");
    this.#refreshArtifact("decisions");
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
      case "phase":
        this.#phase = event.phase;
        if (event.note) {
          // e.g. the beyond-registry fallback explanation — surfaced in the log.
          this.#entries.push({ kind: "info", text: event.note });
        }
        break;
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
    } else if (tab === "architecture") {
      // Re-read `product/index.yaml` (same mechanism as the Goal tab's README):
      // an `artifact_changed{tab:"architecture"}` lands here and the next render
      // reflects the fresh framing — no restart (SIBYL-016).
      this.#architectureContent = this.#readArtifact("architecture");
    } else if (tab === "decisions") {
      this.#decisionsContent = this.#readArtifact("decisions");
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
    // The AEP phase indicator (SIBYL-016): e.g. `[envision]` when the detected
    // phase session is envision — asserted by the zero-quota render smokes.
    const phase = this.#phase ? ` ${t.accent(`[${this.#phase}]`)}` : "";
    const left = ` ${t.title("SIBYL")} ${t.muted(`· ${this.#project}`)}${phase}`;
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
    // The Architecture tab renders the envision output `product/index.yaml`
    // live (SIBYL-016): a parsed outline of the framing, a preformatted raw
    // view when the YAML is unparseable, or a themed empty state until the
    // envision phase submits.
    if (tab.id === "architecture") {
      if (!this.#architectureContent || this.#architectureContent.trim().length === 0) {
        return fitLines(
          [t.muted(ARCHITECTURE_EMPTY_STATE), "", t.dim("(the envision agent submits it via submit_envision)")],
          height,
        );
      }
      return fitLines(renderArchitecture(this.#architectureContent, innerWidth, t), height);
    }
    // Once the agent has committed, the Decisions tab renders the captured log
    // (WYSIWYG) instead of the placeholder (SIBYL-011).
    if (tab.id === "decisions" && this.#decisionsContent && this.#decisionsContent.trim().length > 0) {
      return fitLines(wrap(this.#decisionsContent, innerWidth), height);
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
      case "info":
        return wrap(`· ${entry.text}`, width).map((line) => t.muted(line));
      case "error":
        return wrap(`  ✗ ${entry.text}`, width).map((line) => t.error(line));
      default:
        return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Architecture tab: parse-and-outline of `product/index.yaml` (SIBYL-016).
// ---------------------------------------------------------------------------

/** One backbone activity of the parsed framing (subset the outline shows). */
interface FramingActivity {
  readonly name: string;
  readonly order: number | undefined;
  readonly layerIntroduced: number | undefined;
}

/** One release layer of the parsed framing. */
interface FramingLayer {
  readonly layer: number | undefined;
  readonly name: string;
  readonly userCan: string;
}

/** The slice of `product/index.yaml` the Architecture outline renders. */
interface Framing {
  readonly problem: string | undefined;
  readonly activities: readonly FramingActivity[];
  readonly layers: readonly FramingLayer[];
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Parse the envision artifact text into the outline's {@link Framing} slice.
 * Returns `undefined` when the text is not YAML or not framing-shaped — the
 * caller then falls back to a readable preformatted view (never a crash: the
 * cockpit must render whatever is on disk).
 */
function parseFraming(text: string): Framing | undefined {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return undefined;
  }
  const product = asObject(asObject(doc)?.product);
  if (!product) {
    return undefined;
  }

  const problem = typeof product.problem === "string" ? product.problem : undefined;

  const activities: FramingActivity[] = (Array.isArray(product.activities) ? product.activities : [])
    .map((item): FramingActivity | undefined => {
      const record = asObject(item);
      if (!record) {
        return undefined;
      }
      const name =
        typeof record.name === "string" ? record.name : typeof record.id === "string" ? record.id : undefined;
      if (name === undefined) {
        return undefined;
      }
      return {
        name,
        order: asOptionalNumber(record.order),
        layerIntroduced: asOptionalNumber(record.layer_introduced),
      };
    })
    .filter((item): item is FramingActivity => item !== undefined)
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));

  const layers: FramingLayer[] = (Array.isArray(product.layers) ? product.layers : [])
    .map((item): FramingLayer | undefined => {
      const record = asObject(item);
      if (!record || typeof record.name !== "string") {
        return undefined;
      }
      return {
        layer: asOptionalNumber(record.layer),
        name: record.name,
        userCan: typeof record.user_can === "string" ? record.user_can : "",
      };
    })
    .filter((item): item is FramingLayer => item !== undefined);

  if (problem === undefined && activities.length === 0 && layers.length === 0) {
    return undefined;
  }
  return { problem, activities, layers };
}

/**
 * Render the Architecture tab body: a themed OUTLINE of the product framing
 * (problem one-liner, backbone activities with order + introduction layer,
 * release layers with what the user can do) when `product/index.yaml` parses,
 * else the raw text preformatted. Pure lines-in-lines-out — headless-testable.
 */
function renderArchitecture(text: string, width: number, t: Theme): string[] {
  const framing = parseFraming(text);
  if (!framing) {
    // Unparseable / unexpected shape: show the file as-is (readable, never a crash).
    return text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => truncateToWidth(line, width));
  }

  const lines: string[] = [t.title("Product framing"), ""];

  if (framing.problem !== undefined && framing.problem.trim().length > 0) {
    lines.push(t.accent("Problem"));
    for (const line of wrap(framing.problem, Math.max(1, width - 2))) {
      lines.push(`  ${line}`);
    }
    lines.push("");
  }

  if (framing.activities.length > 0) {
    lines.push(t.accent("Activities (backbone order)"));
    for (const activity of framing.activities) {
      const order = activity.order !== undefined ? `${activity.order}.` : "·";
      const intro = activity.layerIntroduced !== undefined ? ` — introduced L${activity.layerIntroduced}` : "";
      lines.push(truncateToWidth(`  ${order} ${activity.name}${intro}`, width));
    }
    lines.push("");
  }

  if (framing.layers.length > 0) {
    lines.push(t.accent("Layers (thinnest first)"));
    for (const layer of framing.layers) {
      const tag = layer.layer !== undefined ? `L${layer.layer}` : "L?";
      const detail = layer.userCan.length > 0 ? ` — user can: ${layer.userCan}` : "";
      const wrapped = wrap(`${tag} ${layer.name}${detail}`, Math.max(1, width - 2));
      for (const line of wrapped) {
        lines.push(`  ${line}`);
      }
    }
  }

  while (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
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
