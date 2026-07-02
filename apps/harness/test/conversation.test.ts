import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  COCKPIT_BEYOND_REGISTRY_NOTE,
  COCKPIT_ORIGINATE_POINTER,
  COCKPIT_TOOLS,
  type ConversationEvent,
  type ConversationSession,
  createCockpitCompletionHooks,
  createConversation,
  defaultConversationConnect,
  resolveCockpitPhase,
} from "../src/engine/conversation";
import { getPhaseSpec, loadPhaseBrief } from "../src/engine/flow";
import type { DecisionEntry } from "../src/memory/decisions";

/**
 * The conversation seam adapts the Pi `AgentSession` event stream into the small
 * cockpit {@link ConversationEvent} union. These tests drive it with a SCRIPTED
 * session double (real event shapes, NO live model), mirroring how the harness
 * tests the originate flow.
 */

/** A type-faithful assistant message (matches the SDK `AssistantMessage`). */
function assistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "anthropic",
    provider: "anthropic",
    model: "scripted-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: 0,
  };
}

/** A scripted `ConversationSession` double: emits a fixed event stream on `prompt`. */
class FakeAgentSession implements ConversationSession {
  activeTools: string[] = [];
  readonly prompts: string[] = [];
  aborted = false;
  disposed = false;
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();
  readonly #script: (prompt: string) => AgentSessionEvent[];

  constructor(script: (prompt: string) => AgentSessionEvent[]) {
    this.#script = script;
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  setActiveToolsByName(toolNames: string[]): void {
    this.activeTools = [...toolNames];
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    for (const event of this.#script(text)) {
      for (const listener of Array.from(this.#listeners)) {
        listener(event);
      }
    }
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** A realistic agent run: greet, write README, close. */
function runScript(): AgentSessionEvent[] {
  const message = assistantMessage("");
  return [
    { type: "agent_start" },
    {
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Who's it for? ",
        partial: message,
      },
    },
    {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "write",
      args: { path: "README.md" },
    },
    { type: "tool_execution_end", toolCallId: "t1", toolName: "write", result: {}, isError: false },
    {
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Drafted it.",
        partial: message,
      },
    },
    { type: "agent_end", messages: [message], willRetry: false },
  ];
}

/** A run where the agent commits the README via the narrow `git` tool. */
function commitScript(): AgentSessionEvent[] {
  const message = assistantMessage("");
  return [
    { type: "agent_start" },
    {
      type: "tool_execution_start",
      toolCallId: "g1",
      toolName: "git",
      args: { subcommand: "commit", args: ["-m", "docs: add project README"], cwd: "/tmp/ignored" },
    },
    {
      type: "tool_execution_end",
      toolCallId: "g1",
      toolName: "git",
      result: { exitCode: 0, stdout: "", stderr: "" },
      isError: false,
    },
    { type: "agent_end", messages: [message], willRetry: false },
  ];
}

/** A run where the agent only STAGES the README (`git add`) — not a decision. */
function addScript(): AgentSessionEvent[] {
  const message = assistantMessage("");
  return [
    { type: "agent_start" },
    {
      type: "tool_execution_start",
      toolCallId: "g1",
      toolName: "git",
      args: { subcommand: "add", args: ["README.md"], cwd: "/tmp/ignored" },
    },
    {
      type: "tool_execution_end",
      toolCallId: "g1",
      toolName: "git",
      result: { exitCode: 0, stdout: "", stderr: "" },
      isError: false,
    },
    { type: "agent_end", messages: [message], willRetry: false },
  ];
}

function collect(): {
  events: ConversationEvent[];
  fake: FakeAgentSession;
  conversation: ReturnType<typeof createConversation>;
} {
  const fake = new FakeAgentSession(runScript);
  const conversation = createConversation({ cwd: "/tmp/ignored", connect: async () => fake });
  const events: ConversationEvent[] = [];
  conversation.subscribe((event) => events.push(event));
  return { events, fake, conversation };
}

describe("conversation seam — AgentSessionEvent → ConversationEvent", () => {
  it("echoes the user, gates cockpit tools, and maps the run to cockpit events", async () => {
    const { events, fake, conversation } = collect();

    await conversation.dispatch({ type: "send", text: "build a task tracker" });

    // Tools gated to the cockpit set on connect.
    expect(fake.activeTools).toEqual([...COCKPIT_TOOLS]);
    expect(fake.prompts).toEqual(["build a task tracker"]);

    // The user's message is echoed first.
    expect(events[0]).toEqual({ type: "user_echo", text: "build a task tracker" });

    // Streaming status brackets the run.
    expect(events.some((e) => e.type === "status" && e.state === "streaming")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "status", state: "idle" });

    // Assistant text arrives as deltas, in order.
    const deltas = events.filter((e) => e.type === "assistant_delta").map((e) => e.text);
    expect(deltas.join("")).toBe("Who's it for? Drafted it.");

    // The write tool surfaces start + end.
    const tools = events.filter((e) => e.type === "tool");
    expect(tools).toEqual([
      { type: "tool", name: "write", phase: "start", detail: "README.md" },
      { type: "tool", name: "write", phase: "end", detail: "README.md", isError: false },
    ]);

    // A write and the run end both invalidate the Goal tab.
    expect(
      events.filter((e) => e.type === "artifact_changed" && e.tab === "goal").length,
    ).toBeGreaterThanOrEqual(2);

    // The assistant response is finalized.
    expect(events.some((e) => e.type === "assistant_done")).toBe(true);

    await conversation.dispose();
    expect(fake.disposed).toBe(true);
  });

  it("routes an abort command to the session", async () => {
    const { fake, conversation } = collect();
    await conversation.dispatch({ type: "send", text: "hi" }); // connect first
    await conversation.dispatch({ type: "abort" });
    expect(fake.aborted).toBe(true);
    await conversation.dispose();
  });

  it("captures a git commit of the README as a decision and surfaces the Decisions tab", async () => {
    const fake = new FakeAgentSession(commitScript);
    const captured: DecisionEntry[] = [];
    const conversation = createConversation({
      cwd: "/tmp/ignored",
      connect: async () => fake,
      // Inject a spy sink so the headless run needs no real ExtensionAPI.
      captureDecision: (entry) => captured.push(entry),
      now: () => 1_719_000_000_000,
    });
    const events: ConversationEvent[] = [];
    conversation.subscribe((event) => events.push(event));

    await conversation.dispatch({ type: "send", text: "commit the readme" });

    // AC2: exactly one decision-memory entry, sensibly shaped.
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      id: "originate-1719000000000",
      phase: "originate",
      decision: 'Committed README.md — "docs: add project README"',
      at: 1_719_000_000_000,
    });

    // AC3: the capture is surfaced — a `decision_captured` event carrying the entry
    // plus an `artifact_changed{tab:"decisions"}` so the Decisions tab re-renders.
    const decisionEvent = events.find((e) => e.type === "decision_captured");
    expect(decisionEvent).toEqual({ type: "decision_captured", entry: captured[0] });
    expect(events.some((e) => e.type === "artifact_changed" && e.tab === "decisions")).toBe(true);

    await conversation.dispose();
  });

  it("does NOT capture a decision for a non-commit git op (git add)", async () => {
    const fake = new FakeAgentSession(addScript);
    const captured: DecisionEntry[] = [];
    const conversation = createConversation({
      cwd: "/tmp/ignored",
      connect: async () => fake,
      captureDecision: (entry) => captured.push(entry),
    });
    const events: ConversationEvent[] = [];
    conversation.subscribe((event) => events.push(event));

    await conversation.dispatch({ type: "send", text: "stage the readme" });

    expect(captured).toHaveLength(0);
    expect(events.some((e) => e.type === "decision_captured")).toBe(false);
    expect(events.some((e) => e.type === "artifact_changed" && e.tab === "decisions")).toBe(false);

    await conversation.dispose();
  });

  it("surfaces a connect failure as an error event", async () => {
    const events: ConversationEvent[] = [];
    const conversation = createConversation({
      cwd: "/tmp/ignored",
      connect: async () => {
        throw new Error("no model");
      },
    });
    conversation.subscribe((event) => events.push(event));

    await conversation.dispatch({ type: "send", text: "hi" });

    expect(events.some((e) => e.type === "error" && e.detail.includes("no model"))).toBe(true);
    expect(events.at(-1)).toEqual({ type: "status", state: "idle" });
    await conversation.dispose();
  });
});

/**
 * SIBYL-017 — the originate cockpit carries the guided-originate flow as a
 * COMPILED BRIEF: the full `sibyl-originate` SKILL.md body is injected into the
 * session's system prompt by the harness. The model never has to notice or
 * read the skill file, so the old "thin pointer" (an instruction to go `read`
 * the SKILL.md — a two-step nondeterministic discovery bet) is reduced to a
 * one-line role line. Proven HEADLESSLY: booting the real default connect
 * assembles the prompt without ever calling a model.
 */
describe("originate cockpit brief injection (SIBYL-017)", () => {
  it("reduces the pointer to a one-line role line — no runtime skill-reading instruction", () => {
    expect(COCKPIT_ORIGINATE_POINTER).not.toContain("\n"); // one line
    expect(COCKPIT_ORIGINATE_POINTER).toContain("sibyl-originate"); // still orients
    // The discovery bet is gone: it no longer tells the model to read SKILL.md.
    expect(COCKPIT_ORIGINATE_POINTER).not.toMatch(/`read`|SKILL\.md|<location>/);
  });

  it("the default cockpit connect injects the sibyl-originate BODY into the system prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sibyl-conv-cockpit-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      const session = await defaultConversationConnect(dir, new AbortController().signal);
      try {
        // The real cockpit session is a Pi AgentSession; read its assembled prompt.
        const prompt = (session as AgentSession).systemPrompt;

        // Role line first-ish (persona precedes it), then the FULL brief body —
        // asserted via distinctive body lines, not just the skill-name listing.
        expect(prompt).toContain(COCKPIT_ORIGINATE_POINTER);
        expect(prompt).toContain(loadPhaseBrief("sibyl-originate"));
        expect(prompt).toContain("you run git, never the user");
        expect(prompt).toContain("## Conduct the flow");

        // Frontmatter is stripped: no YAML keys leak into the prompt.
        expect(prompt).not.toContain("name: sibyl-originate");

        // Ordering: role line before the injected body.
        expect(prompt.indexOf(COCKPIT_ORIGINATE_POINTER)).toBeLessThan(
          prompt.indexOf("you run git, never the user"),
        );
      } finally {
        await session.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── SIBYL-016: detect-state routing in the cockpit ──────────────────────────

/** A temp git repo shaped as one of the three artifact states the cockpit routes on. */
async function makePhaseRepo(shape: "empty" | "readme-committed" | "beyond"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-conv-phase-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (shape !== "empty") {
    await writeFile(join(dir, "README.md"), "# Goal\n\nA committed, focused goal.\n");
    execFileSync("git", ["add", "README.md"], { cwd: dir });
    execFileSync(
      "git",
      ["-c", "user.email=sibyl@test", "-c", "user.name=SIBYL", "commit", "-q", "-m", "docs: add README"],
      { cwd: dir },
    );
  }
  if (shape === "beyond") {
    await mkdir(join(dir, "product"), { recursive: true });
    await writeFile(join(dir, "product", "index.yaml"), "product: {}\n");
  }
  return dir;
}

describe("cockpit detect-state routing (SIBYL-016)", () => {
  it("resolveCockpitPhase routes by the committed artifacts, without a note", async () => {
    const empty = await makePhaseRepo("empty");
    const envision = await makePhaseRepo("readme-committed");
    try {
      expect(resolveCockpitPhase(empty)).toEqual({ spec: getPhaseSpec("originate") });
      expect(resolveCockpitPhase(envision)).toEqual({ spec: getPhaseSpec("envision") });
    } finally {
      await rm(empty, { recursive: true, force: true });
      await rm(envision, { recursive: true, force: true });
    }
  });

  it("falls back to envision WITH the status note when the artifacts are beyond the registry", async () => {
    const dir = await makePhaseRepo("beyond");
    try {
      // detectPhase THROWS here — the cockpit resolution must not.
      const phase = resolveCockpitPhase(dir);
      expect(phase.spec.id).toBe("envision");
      expect(phase.note).toBe(COCKPIT_BEYOND_REGISTRY_NOTE);
      expect(phase.note).toMatch(/L2/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replays the resolved phase to a subscriber before any send — no connect, no model", async () => {
    const dir = await makePhaseRepo("beyond");
    try {
      let connects = 0;
      const conversation = createConversation({
        cwd: dir,
        connect: async () => {
          connects += 1;
          throw new Error("must not connect for a phase replay");
        },
      });
      const events: ConversationEvent[] = [];
      conversation.subscribe((event) => events.push(event));
      await Promise.resolve(); // flush the deferred replay
      expect(events).toEqual([
        { type: "phase", phase: "envision", note: COCKPIT_BEYOND_REGISTRY_NOTE },
      ]);
      expect(connects).toBe(0); // lazy connect untouched: zero-quota render smokes stay free
      await conversation.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gates the session's tools to the ENVISION allowlist when the README is committed", async () => {
    const dir = await makePhaseRepo("readme-committed");
    try {
      const fake = new FakeAgentSession(runScript);
      const conversation = createConversation({ cwd: dir, connect: async () => fake });
      await conversation.dispatch({ type: "send", text: "frame the product" });
      expect([...fake.activeTools].sort()).toEqual(["find", "grep", "ls", "read", "submit_envision"]);
      await conversation.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("AC1: the default connect boots the ENVISION phase session for a committed README", async () => {
    const dir = await makePhaseRepo("readme-committed");
    try {
      const session = await defaultConversationConnect(dir, new AbortController().signal);
      try {
        const agentSession = session as AgentSession;
        const prompt = agentSession.systemPrompt;

        // The sibyl-envision role line + FULL compiled brief body are injected…
        expect(prompt).toContain(getPhaseSpec("envision").promptBrief);
        expect(prompt).toContain(loadPhaseBrief("sibyl-envision"));
        expect(prompt).toContain("Complete ONLY by calling `submit_envision`");

        // …and the originate shape is NOT: neither its role line nor its brief body.
        expect(prompt).not.toContain(COCKPIT_ORIGINATE_POINTER);
        expect(prompt).not.toContain("you run git, never the user");

        // Active tools are the read-only set PLUS the typed completion tool.
        expect([...agentSession.getActiveToolNames()].sort()).toEqual([
          "find",
          "grep",
          "ls",
          "read",
          "submit_envision",
        ]);
      } finally {
        await session.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the beyond-registry fallback still BOOTS (envision session, cockpit does not crash)", async () => {
    const dir = await makePhaseRepo("beyond");
    try {
      const session = await defaultConversationConnect(dir, new AbortController().signal);
      try {
        const agentSession = session as AgentSession;
        expect(agentSession.systemPrompt).toContain("Complete ONLY by calling `submit_envision`");
        expect([...agentSession.getActiveToolNames()]).toContain("submit_envision");
      } finally {
        await session.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── SIBYL-016: submit_envision completion surfaces on the tabs ──────────────

describe("cockpit completion hooks + submit_envision surfacing (SIBYL-016)", () => {
  it("createCockpitCompletionHooks routes the decision through the SIBYL-011 capture path", () => {
    const captured: DecisionEntry[] = [];
    const emitted: ConversationEvent[] = [];
    const now = (): number => 1_719_000_000_000;
    const hooks = createCockpitCompletionHooks({
      capture: (entry) => captured.push(entry),
      emit: (event) => emitted.push(event),
      now,
    });

    // The submit tool's clock is the conversation's injectable one.
    expect(hooks.now).toBe(now);

    const entry: DecisionEntry = {
      id: "envision-1719000000000",
      phase: "envision",
      decision: "Committed product/index.yaml (envision framing)",
      at: 1_719_000_000_000,
    };
    hooks.onPhaseCompleted?.("envision", {});
    hooks.decisionSink?.(entry);

    expect(captured).toEqual([entry]);
    expect(emitted).toEqual([
      { type: "artifact_changed", tab: "architecture" }, // the framing tab re-renders…
      { type: "decision_captured", entry }, // …and the decision is surfaced…
      { type: "artifact_changed", tab: "decisions" }, // …on the Decisions tab too.
    ]);
  });

  it("a successful submit_envision tool end invalidates the Architecture tab", async () => {
    const script = (): AgentSessionEvent[] => {
      const message = assistantMessage("");
      return [
        { type: "agent_start" },
        {
          type: "tool_execution_start",
          toolCallId: "s1",
          toolName: "submit_envision",
          args: { problem: "…" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "s1",
          toolName: "submit_envision",
          result: {},
          isError: false,
        },
        { type: "agent_end", messages: [message], willRetry: false },
      ];
    };
    const fake = new FakeAgentSession(script);
    const conversation = createConversation({ cwd: "/tmp/ignored", connect: async () => fake });
    const events: ConversationEvent[] = [];
    conversation.subscribe((event) => events.push(event));

    await conversation.dispatch({ type: "send", text: "submit the framing" });

    expect(
      events.some((e) => e.type === "artifact_changed" && e.tab === "architecture"),
    ).toBe(true);
    // The tool round-trip itself surfaces in chat like any other tool.
    expect(
      events.some((e) => e.type === "tool" && e.name === "submit_envision" && e.phase === "end"),
    ).toBe(true);
    await conversation.dispose();
  });

  it("a FAILED submit_envision does not invalidate the Architecture tab", async () => {
    const script = (): AgentSessionEvent[] => {
      const message = assistantMessage("");
      return [
        { type: "agent_start" },
        {
          type: "tool_execution_start",
          toolCallId: "s1",
          toolName: "submit_envision",
          args: { problem: "" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "s1",
          toolName: "submit_envision",
          result: {},
          isError: true,
        },
        { type: "agent_end", messages: [message], willRetry: false },
      ];
    };
    const fake = new FakeAgentSession(script);
    const conversation = createConversation({ cwd: "/tmp/ignored", connect: async () => fake });
    const events: ConversationEvent[] = [];
    conversation.subscribe((event) => events.push(event));

    await conversation.dispatch({ type: "send", text: "submit the framing" });

    expect(
      events.some((e) => e.type === "artifact_changed" && e.tab === "architecture"),
    ).toBe(false);
    await conversation.dispose();
  });
});
