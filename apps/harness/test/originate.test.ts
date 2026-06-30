import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createEngine, type EngineEvent, type EngineSeam } from "../src/engine/seam";
import {
  buildImaginePrompt,
  createOriginateCore,
  ORIGINATE_ACTIVE_TOOLS,
  type OriginateSession,
} from "../src/engine/originate";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Real-shaped Pi event scripting (no live model).
// ---------------------------------------------------------------------------

/** A minimal but type-faithful Pi assistant message (matches `AssistantMessage`). */
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

/**
 * Build a realistic imagine-pass event stream: a read-only tool round-trip, then
 * the assistant streaming its README body as `text_delta`s, terminated by
 * `agent_end`. These are the REAL `AgentSessionEvent` shapes (verified against
 * `@earendil-works/pi-coding-agent@0.80.2`).
 */
function imagineScript(deltas: string[]): AgentSessionEvent[] {
  const message = assistantMessage(deltas.join(""));
  const events: AgentSessionEvent[] = [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "tool_execution_start", toolCallId: "t1", toolName: "ls", args: { path: "." } },
    {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "ls",
      result: { entries: [] },
      isError: false,
    },
    { type: "message_start", message },
  ];
  for (const delta of deltas) {
    events.push({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message },
    });
  }
  events.push({ type: "message_end", message });
  events.push({ type: "turn_end", message, toolResults: [] });
  events.push({ type: "agent_end", messages: [message], willRetry: false });
  return events;
}

/** A scripted `OriginateSession` double that emits real Pi events on `prompt`. */
class ScriptedSession implements OriginateSession {
  activeTools: string[] = [];
  readonly prompts: string[] = [];
  disposed = false;

  readonly #script: AgentSessionEvent[];
  readonly #failWith: Error | undefined;
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();

  constructor(script: AgentSessionEvent[], failWith?: Error) {
    this.#script = script;
    this.#failWith = failWith;
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
    if (this.#failWith) {
      throw this.#failWith;
    }
    for (const event of this.#script) {
      for (const listener of Array.from(this.#listeners)) {
        listener(event);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}

// ---------------------------------------------------------------------------
// Renderer-agnostic event harness (consumes ONLY EngineEvents).
// ---------------------------------------------------------------------------

function harness(engine: EngineSeam) {
  const events: EngineEvent[] = [];
  const waiters: { type: EngineEvent["type"]; resolve: (event: EngineEvent) => void }[] = [];

  engine.subscribe((event) => {
    events.push(event);
    const index = waiters.findIndex((waiter) => waiter.type === event.type);
    if (index !== -1) {
      const [waiter] = waiters.splice(index, 1);
      waiter?.resolve(event);
    }
  });

  return {
    events,
    types: () => events.map((event) => event.type),
    progress: () =>
      events.filter(
        (event): event is Extract<EngineEvent, { type: "progress" }> => event.type === "progress",
      ),
    waitFor: (type: EngineEvent["type"]) =>
      new Promise<EngineEvent>((resolve) => {
        waiters.push({ type, resolve });
      }),
  };
}

// ---------------------------------------------------------------------------
// Temp cwd management + deterministic git identity for the commit step.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
async function tempCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-originate-"));
  tempDirs.push(dir);
  return dir;
}

const gitIdentity: Record<string, string> = {
  GIT_AUTHOR_NAME: "SIBYL Test",
  GIT_AUTHOR_EMAIL: "sibyl@test.local",
  GIT_COMMITTER_NAME: "SIBYL Test",
  GIT_COMMITTER_EMAIL: "sibyl@test.local",
};
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [key, value] of Object.entries(gitIdentity)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

afterEach(() => {
  // Each test boots its own engine/session; nothing global to reset here.
});

const FORM_VALUES = {
  product: "SIBYL",
  problem: "no guided originate flow",
  vision: "a TUI harness that conducts a Pi agent",
} as const;

const README_DELTAS = ["# SIBYL\n\n", "An imagined originate harness.\n"];
const README_BODY = README_DELTAS.join("");

// ---------------------------------------------------------------------------
// Acceptance criteria.
// ---------------------------------------------------------------------------

describe("originate EngineRunCore (SIBYL-003)", () => {
  it("submit_form drives the imagine pass: writes README, maps progress, requests the commit gate", async () => {
    const cwd = await tempCwd();
    const scripted = new ScriptedSession(imagineScript(README_DELTAS));
    const engine = createEngine(createOriginateCore({ connect: async () => scripted }));
    const h = harness(engine);

    // start_run -> form_requested (the originate form).
    const form = h.waitFor("form_requested");
    await engine.dispatch({ type: "start_run", cwd });
    expect(await form).toMatchObject({
      type: "form_requested",
      schema: { fields: ["product", "problem", "vision"] },
    });

    // submit_form -> progress* -> decision_requested.
    const decision = h.waitFor("decision_requested");
    await engine.dispatch({ type: "submit_form", values: { ...FORM_VALUES } });

    // Criterion 3: the commit-gate decision is emitted on completion.
    expect(await decision).toMatchObject({
      type: "decision_requested",
      prompt: "Commit this README?",
      options: ["Commit", "Revise", "Cancel"],
    });

    // Criterion 1: README.md draft written to the cwd from the agent's imagine output.
    const readme = await readFile(join(cwd, "README.md"), "utf8");
    expect(readme).toBe(README_BODY);

    // The prompt was seeded with the form values; tools were gated read-only + git.
    expect(scripted.prompts).toHaveLength(1);
    expect(scripted.prompts[0]).toContain("SIBYL");
    expect(scripted.prompts[0]).toContain("no guided originate flow");
    expect(scripted.prompts[0]).toContain("a TUI harness that conducts a Pi agent");
    expect(scripted.activeTools).toEqual([...ORIGINATE_ACTIVE_TOOLS]);
    expect([...ORIGINATE_ACTIVE_TOOLS]).toEqual(["read", "grep", "find", "ls", "git"]);
    expect(scripted.disposed).toBe(true);

    // Criterion 2: tool_execution_* and message_update became progress events, in order.
    const progress = h.progress();
    expect(progress.map((event) => event.kind)).toEqual([
      "tool_execution",
      "tool_execution",
      "message_update",
      "message_update",
    ]);
    expect(progress.map((event) => event.detail)).toEqual([
      "ls: started",
      "ls: done",
      "# SIBYL\n\n",
      "An imagined originate harness.\n",
    ]);

    // The exact ordered EngineEvent stream up to the decision gate.
    expect(h.types()).toEqual([
      "phase_changed", // idle -> form
      "form_requested",
      "phase_changed", // form -> running
      "progress", // tool_execution_start
      "progress", // tool_execution_end
      "progress", // message_update (text_delta)
      "progress", // message_update (text_delta)
      "phase_changed", // running -> decision
      "decision_requested",
    ]);
    expect(engine.phase).toBe("decision");
  });

  it("complete: commits the README draft via the git tool on a Commit decision", async () => {
    const cwd = await tempCwd();
    const scripted = new ScriptedSession(imagineScript(README_DELTAS));
    const engine = createEngine(
      createOriginateCore({ connect: async () => scripted, commitMessage: "docs: test originate" }),
    );
    const h = harness(engine);

    const decision = h.waitFor("decision_requested");
    await engine.dispatch({ type: "start_run", cwd });
    await engine.dispatch({ type: "submit_form", values: { ...FORM_VALUES } });
    await decision;

    const completed = h.waitFor("run_completed");
    await engine.dispatch({ type: "submit_decision", choice: "Commit" });
    expect(await completed).toMatchObject({
      type: "run_completed",
      artifacts: ["README.md"],
      decisions: 1,
    });
    expect(engine.phase).toBe("done");

    // The engine git-tool path actually produced a commit tracking README.md.
    const { stdout: tracked } = await execFileAsync("git", ["ls-files"], { cwd });
    expect(tracked.trim()).toBe("README.md");
    const { stdout: log } = await execFileAsync("git", ["log", "--oneline"], { cwd });
    expect(log).toContain("docs: test originate");
  });

  it("falls back to a values-seeded README when the agent streams no text", async () => {
    const cwd = await tempCwd();
    const scripted = new ScriptedSession(imagineScript([])); // tool events only, no text_delta
    const engine = createEngine(createOriginateCore({ connect: async () => scripted }));
    const h = harness(engine);

    const decision = h.waitFor("decision_requested");
    await engine.dispatch({ type: "start_run", cwd });
    await engine.dispatch({ type: "submit_form", values: { ...FORM_VALUES } });
    await decision;

    const readme = await readFile(join(cwd, "README.md"), "utf8");
    expect(readme).toContain("# SIBYL");
    expect(readme).toContain("no guided originate flow");
    expect(readme).toContain("a TUI harness that conducts a Pi agent");
    // Still surfaced the read-only tool steps as progress.
    expect(h.progress().map((event) => event.kind)).toEqual(["tool_execution", "tool_execution"]);
  });

  it("classifies a prompt failure as run_failed{agent}", async () => {
    const cwd = await tempCwd();
    const scripted = new ScriptedSession([], new Error("model unavailable"));
    const engine = createEngine(createOriginateCore({ connect: async () => scripted }));
    const h = harness(engine);

    await engine.dispatch({ type: "start_run", cwd });
    const failed = h.waitFor("run_failed");
    await engine.dispatch({ type: "submit_form", values: { ...FORM_VALUES } });

    expect(await failed).toMatchObject({ type: "run_failed", class: "agent" });
    expect(engine.phase).toBe("failed");
    expect(scripted.disposed).toBe(true); // session released even on failure
  });

  it("buildImaginePrompt seeds the form values and forbids file writes", () => {
    const prompt = buildImaginePrompt({ ...FORM_VALUES });
    expect(prompt).toContain("Product: SIBYL");
    expect(prompt).toContain("Problem: no guided originate flow");
    expect(prompt).toContain("Vision: a TUI harness that conducts a Pi agent");
    expect(prompt).toContain("Output ONLY the README markdown");
    expect(prompt).toContain("file-writing tools are disabled");
  });
});
