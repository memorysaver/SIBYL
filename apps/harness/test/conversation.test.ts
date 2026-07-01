import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import {
  COCKPIT_TOOLS,
  type ConversationEvent,
  type ConversationSession,
  createConversation,
} from "../src/engine/conversation";
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
