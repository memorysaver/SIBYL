/**
 * SIBYL-008: End-to-end Originate journey (integration).
 *
 * Exercises the COMPOSED pipeline from `src/main.ts` — engine + headless renderer
 * (shell view + modal-form controller) + narrow git tool + decision-memory — from
 * a fresh empty temp dir, with a scripted Pi `AgentSession` (real `AgentSessionEvent`
 * shapes, no live model). This is the honest proof of the three acceptance criteria:
 *
 *   1. a full run produces a COMMITTED `README.md` in a new local git repo;
 *   2. ≥1 decision-memory entry is persisted (recallable via `recallDecisions`);
 *   3. live progress flows end-to-end and the form values + commit choice arrive
 *      THROUGH the modal-form controller (no raw Pi/git commands).
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OriginateSession } from "../src/engine/originate";
import { ORIGINATE_ACTIVE_TOOLS } from "../src/engine/originate";
import { recallDecisions } from "../src/memory/decisions";
import { runCli, runOriginate, type CliIO } from "../src/main";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// A capturing scripted session (real Pi event shapes) over the `connect` port.
// ---------------------------------------------------------------------------

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

class CapturingSession implements OriginateSession {
  activeTools: string[] = [];
  readonly prompts: string[] = [];
  disposed = false;
  readonly #script: AgentSessionEvent[];
  readonly #listeners = new Set<(event: AgentSessionEvent) => void>();

  constructor(deltas: string[]) {
    this.#script = imagineScript(deltas);
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setActiveToolsByName(toolNames: string[]): void {
    this.activeTools = [...toolNames];
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
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
// Temp cwd + deterministic git identity for the commit step.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
async function tempCwd(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-e2e-"));
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

const FORM_VALUES = {
  product: "SIBYL",
  problem: "no guided originate flow",
  vision: "a TUI harness that conducts a Pi agent",
} as const;

// ---------------------------------------------------------------------------
// Acceptance criteria.
// ---------------------------------------------------------------------------

describe("end-to-end Originate journey (SIBYL-008)", () => {
  it("from an empty dir: composes engine+renderer+tools+memory into a committed README + a persisted decision", async () => {
    const cwd = await tempCwd();
    const deltas = ["# SIBYL\n\n", "An imagined originate harness.\n"];
    const session = new CapturingSession(deltas);

    const result = await runOriginate({
      cwd,
      values: { ...FORM_VALUES },
      decision: "Commit",
      connect: async () => session,
      commitMessage: "docs: e2e originate README",
      now: () => 1_719_000_000_000,
    });

    // ── Criterion 1: a committed README.md in a NEW local git repo. ──────────
    expect(result.completion).toEqual({ artifacts: ["README.md"], decisions: 1 });
    expect(result.failure).toBeUndefined();

    const readme = await readFile(join(cwd, "README.md"), "utf8");
    expect(readme).toBe(deltas.join(""));

    const { stdout: tracked } = await execFileAsync("git", ["ls-files"], { cwd });
    expect(tracked.trim()).toBe("README.md");
    const { stdout: log } = await execFileAsync("git", ["log", "--oneline"], { cwd });
    expect(log).toContain("docs: e2e originate README");
    const { stdout: show } = await execFileAsync("git", ["show", "--stat", "HEAD"], { cwd });
    expect(show).toContain("README.md");

    // ── Criterion 2: ≥1 decision-memory entry persisted + recallable. ───────
    expect(result.decisions.length).toBeGreaterThanOrEqual(1);
    expect(result.decisions[0]).toMatchObject({ phase: "originate", decision: "Commit" });
    // Recall again straight from the store to prove it round-trips through memory.
    expect(recallDecisions(result.sessionManager).length).toBeGreaterThanOrEqual(1);

    // ── Criterion 3: live progress flowed; input went via the controller. ───
    const types = result.events.map((event) => event.type);
    expect(types).toEqual([
      "phase_changed", // idle -> form
      "form_requested",
      "phase_changed", // form -> running
      "progress", // ls: started
      "progress", // ls: done
      "progress", // text_delta
      "progress", // text_delta
      "phase_changed", // running -> decision
      "decision_requested",
      "phase_changed", // decision -> done
      "run_completed",
    ]);

    // The streamed progress reached the shell view's log (renderer wired).
    expect(result.view.progress.length).toBeGreaterThanOrEqual(4);

    // The seeded values + choice arrived THROUGH the modal-form controller: they
    // were only ever set via `form.setValue` / `form.chooseDecision`, and they
    // reached the agent (the imagine prompt) and the model selection.
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toContain("SIBYL");
    expect(session.prompts[0]).toContain("no guided originate flow");
    expect(session.prompts[0]).toContain("a TUI harness that conducts a Pi agent");
    expect(session.activeTools).toEqual([...ORIGINATE_ACTIVE_TOOLS]);
    expect(session.disposed).toBe(true);
    expect(result.form.model.values()).toEqual({ ...FORM_VALUES });
    expect(result.form.model.selectedChoice).toBe("Commit");
  });

  it("the default scripted connect (no injected session) still walks the skeleton", async () => {
    const cwd = await tempCwd();
    const result = await runOriginate({
      cwd,
      values: { ...FORM_VALUES },
      now: () => 1_719_000_000_001,
    });

    expect(result.completion?.artifacts).toEqual(["README.md"]);
    expect(result.decisions.length).toBeGreaterThanOrEqual(1);
    const readme = await readFile(join(cwd, "README.md"), "utf8");
    expect(readme).toContain("# SIBYL");
    expect(readme).toContain("no guided originate flow");
    const { stdout: log } = await execFileAsync("git", ["log", "--oneline"], { cwd });
    expect(log.trim().split("\n")).toHaveLength(1);
  });
});

describe("sibyl CLI (Tier-2 dogfood surface)", () => {
  function capture(): { io: CliIO; lines: string[]; errors: string[] } {
    const lines: string[] = [];
    const errors: string[] = [];
    return { io: { out: (l) => lines.push(l), err: (l) => errors.push(l) }, lines, errors };
  }

  it("--version prints the harness version and exits 0", async () => {
    const { io, lines } = capture();
    const code = await runCli(["--version"], io);
    expect(code).toBe(0);
    expect(lines).toEqual(["sibyl 0.0.0"]);
  });

  it("originate drives the full flow then decisions ls reads the persisted decision back", async () => {
    const cwd = await tempCwd();

    const run = capture();
    const originateCode = await runCli(
      [
        "originate",
        "--product",
        "SIBYL",
        "--problem",
        "no guided originate flow",
        "--vision",
        "a TUI harness that conducts a Pi agent",
        "--yes",
        "--cwd",
        cwd,
      ],
      run.io,
    );

    expect(originateCode).toBe(0);
    const stdout = run.lines.join("\n");
    expect(stdout).toContain("phase: form");
    expect(stdout).toContain("progress:");
    expect(stdout).toContain("artifacts: README.md");
    expect(stdout).toContain("decisions: 1");

    // README committed in a new repo — no raw git typed.
    const { stdout: tracked } = await execFileAsync("git", ["ls-files"], { cwd });
    expect(tracked.trim()).toBe("README.md");

    // The journey's `decisions ls` reads the persisted decision across invocations.
    const ls = capture();
    const lsCode = await runCli(["decisions", "ls", "--cwd", cwd], ls.io);
    expect(lsCode).toBe(0);
    expect(ls.lines.join("\n")).toContain("decisions: 1");
    expect(ls.lines.join("\n")).toContain("[originate] Commit");
  });

  it("originate refuses to run without the required seed values", async () => {
    const { io } = capture();
    const code = await runCli(["originate", "--product", "only"], io);
    expect(code).toBe(2);
  });
});
