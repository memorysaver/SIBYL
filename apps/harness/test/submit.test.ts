import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check, Errors } from "typebox/value";
import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecisionEntry } from "../src/memory/decisions";
import {
  bootPhaseSession,
  createFsArtifactProbe,
  createPhaseGuardExtension,
  detectPhase,
  evaluatePhaseToolCall,
  getPhaseSpec,
} from "../src/engine/flow";
import {
  ENVISION_ARTIFACT_RELPATH,
  ENVISION_COMMIT_MESSAGE,
  ENVISION_DECISION_TEXT,
  EnvisionSubmissionSchema,
  SUBMIT_ENVISION_TOOL_NAME,
  createEnvisionSubmitTool,
  createSubmitTool,
  envisionSemanticErrors,
  serializeEnvisionYaml,
  type EnvisionSubmission,
  type SubmitGitRunner,
} from "../src/engine/submit";

/**
 * SIBYL-014 — typed phase completion (`createSubmitTool` / `submit_envision`).
 * Proven HEADLESSLY (no live model), per the story's acceptance criteria:
 *
 *  AC1  schema-invalid payloads are rejected with actionable content naming the
 *       offending fields (schema-level: the same TypeBox contract the SDK
 *       compiles and validates BEFORE execute; semantic-level: execute rejects
 *       with NO side effects — no file write, no hooks).
 *  AC2  a valid payload makes the HARNESS write `product/index.yaml` (YAML that
 *       round-trips the submitted structure), commit it in a real temp git
 *       repo, and fire `onPhaseCompleted` + the decision sink.
 *  AC3  under the SIBYL-013 guard, an envision session cannot produce the
 *       artifact by raw write — `submit_envision` is the ONLY path (exempt, and
 *       succeeding end-to-end in a temp repo).
 */

// ─── helpers ─────────────────────────────────────────────────────────────────

const FIXED_NOW = 1_751_414_400_000; // 2026-07-02T00:00:00Z, injected — no Date.now in assertions.

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

/** A REAL temp git repo shaped like an envision-phase project: committed README, no product/. */
async function makeEnvisionRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sibyl-submit-"));
  tempDirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "sibyl@test");
  git("config", "user.name", "SIBYL");
  await writeFile(join(dir, "README.md"), "# Goal\n\nA focused product goal.\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "docs: add README");
  return dir;
}

function gitOut(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

/** The only slice of ExtensionContext the submit tool reads is `cwd`. */
function ctxFor(cwd: string): ExtensionContext {
  return { cwd } as ExtensionContext;
}

/** A fresh, fully valid envision submission fixture. */
function validPayload(): EnvisionSubmission {
  return {
    problem: "AEP demands 7-phase fluency, so progress is hard to align across a small team.",
    personas: [
      { name: "solo-aep-builder", description: "The AEP author dogfooding SIBYL on real projects." },
      { name: "small-team-collaborator", description: "A collaborator without deep AEP fluency." },
    ],
    activities: [
      { id: "originate", name: "Originate", order: 1, layer_introduced: 0 },
      {
        id: "envision",
        name: "Envision",
        order: 2,
        layer_introduced: 1,
        description: "frame the product from the originate README",
      },
    ],
    layers: [
      { layer: 0, name: "Originate (walking skeleton)", user_can: "Commit a README via the cockpit." },
      { layer: 1, name: "Envision", user_can: "Turn the README into product/index.yaml." },
    ],
    mvp_boundary: {
      in_scope: ["Guided envision interview", "Typed submit_envision completion"],
      out_of_scope: ["Remote repo creation", "Story-map rendering"],
    },
    goals: ["Make the AEP journey legible."],
  };
}

/**
 * Capture the `tool_call` handler a guard factory registers (the exact
 * pre-execution contract a real Pi session invokes).
 */
type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: ExtensionContext,
) => ToolCallEventResult | void | Promise<ToolCallEventResult | void>;

function toolCallHandlerOf(factory: ExtensionFactory): ToolCallHandler {
  let handler: ToolCallHandler | undefined;
  const pi = {
    on: (eventName: string, h: unknown) => {
      if (eventName === "tool_call") {
        handler = h as ToolCallHandler;
      }
    },
  } as unknown as ExtensionAPI;
  void factory(pi);
  if (!handler) {
    throw new Error("guard factory did not register a tool_call handler");
  }
  return handler;
}

function call(toolName: string, input: Record<string, unknown>): ToolCallEvent {
  return { type: "tool_call", toolCallId: "t1", toolName, input } as ToolCallEvent;
}

// ─── AC1a: the schema-level contract ─────────────────────────────────────────

describe("submit_envision schema (AC1) — the TypeBox output contract", () => {
  // The SDK compiles `parameters` and validates BEFORE execute (pi-ai's
  // validateToolArguments), returning the violations to the model as a tool
  // error it retries. These checks exercise the same TypeBox contract.
  it("accepts the valid fixture", () => {
    expect(Check(EnvisionSubmissionSchema, validPayload())).toBe(true);
  });

  it("rejects a missing `problem`, naming the field", () => {
    const { problem: _dropped, ...rest } = validPayload();
    expect(Check(EnvisionSubmissionSchema, rest)).toBe(false);
    const messages = [...Errors(EnvisionSubmissionSchema, rest)].map(
      (error) => `${error.instancePath} ${error.message}`,
    );
    expect(messages.join("\n")).toContain("problem");
  });

  it("rejects wrong-typed `activities` (string instead of array), naming the field", () => {
    const bad = { ...validPayload(), activities: "originate" };
    expect(Check(EnvisionSubmissionSchema, bad)).toBe(false);
    const paths = [...Errors(EnvisionSubmissionSchema, bad)].map((error) => error.instancePath);
    expect(paths).toContain("/activities");
  });

  it("rejects wrong-typed activity fields (order as string)", () => {
    const payload = validPayload();
    const bad = {
      ...payload,
      activities: [{ ...payload.activities[0], order: "first" }],
    };
    expect(Check(EnvisionSubmissionSchema, bad)).toBe(false);
  });

  it("rejects empty personas / activities / layers / in_scope (minItems)", () => {
    expect(Check(EnvisionSubmissionSchema, { ...validPayload(), personas: [] })).toBe(false);
    expect(Check(EnvisionSubmissionSchema, { ...validPayload(), activities: [] })).toBe(false);
    expect(Check(EnvisionSubmissionSchema, { ...validPayload(), layers: [] })).toBe(false);
    const payload = validPayload();
    expect(
      Check(EnvisionSubmissionSchema, {
        ...payload,
        mvp_boundary: { ...payload.mvp_boundary, in_scope: [] },
      }),
    ).toBe(false);
  });

  it("accepts a payload without the optional extras (goals/non_goals/descriptions)", () => {
    const { goals: _goals, ...core } = validPayload();
    expect(Check(EnvisionSubmissionSchema, core)).toBe(true);
  });
});

// ─── AC1b: semantic validation — actionable rejects, zero side effects ──────

describe("submit_envision semantic validation (AC1) — rejects with no side effects", () => {
  it("envisionSemanticErrors names each offending field (pure rule matrix)", () => {
    expect(envisionSemanticErrors(validPayload())).toEqual([]);

    const payload = validPayload();
    const dupIds = {
      ...payload,
      activities: [
        { id: "originate", name: "Originate", order: 1, layer_introduced: 0 },
        { id: "originate", name: "Originate again", order: 2, layer_introduced: 1 },
      ],
    };
    expect(envisionSemanticErrors(dupIds)).toEqual([
      'activities: duplicate id "originate" — activity ids must be unique.',
    ]);

    const unsorted = {
      ...payload,
      layers: [
        { layer: 1, name: "Later", user_can: "later things" },
        { layer: 0, name: "Earlier", user_can: "earlier things" },
      ],
    };
    expect(envisionSemanticErrors(unsorted).join("\n")).toContain(
      "layers: must be sorted ascending",
    );

    const dupLayers = {
      ...payload,
      layers: [
        { layer: 1, name: "One", user_can: "x" },
        { layer: 1, name: "One again", user_can: "y" },
      ],
    };
    expect(envisionSemanticErrors(dupLayers).join("\n")).toContain(
      "layers: duplicate layer 1",
    );

    expect(envisionSemanticErrors({ ...payload, activities: [] }).join("\n")).toContain(
      "activities: at least one activity is required.",
    );
    expect(envisionSemanticErrors({ ...payload, layers: [] }).join("\n")).toContain(
      "layers: at least one layer is required.",
    );
    expect(envisionSemanticErrors({ ...payload, personas: [] }).join("\n")).toContain(
      "personas: at least one persona is required.",
    );
    expect(envisionSemanticErrors({ ...payload, problem: "   " }).join("\n")).toContain(
      "problem: must be a non-empty product problem statement.",
    );
    expect(
      envisionSemanticErrors({
        ...payload,
        mvp_boundary: { in_scope: ["  "], out_of_scope: [] },
      }).join("\n"),
    ).toContain("mvp_boundary.in_scope: must contain at least one non-empty in-scope item.");
  });

  it("execute rejects a semantically invalid payload: actionable message, no write, no commit, no hooks", async () => {
    const dir = await makeEnvisionRepo();
    const onPhaseCompleted = vi.fn();
    const decisionSink = vi.fn();
    const tool = createEnvisionSubmitTool({
      now: () => FIXED_NOW,
      onPhaseCompleted,
      decisionSink,
    });

    const payload = validPayload();
    payload.activities = [
      { id: "originate", name: "Originate", order: 1, layer_introduced: 0 },
      { id: "originate", name: "Duplicate", order: 2, layer_introduced: 1 },
    ];

    // Throwing IS the SDK's semantic-reject path: the agent loop converts the
    // thrown message into an `isError: true` tool result the model retries on.
    await expect(
      tool.execute("t1", payload, undefined, undefined, ctxFor(dir)),
    ).rejects.toThrow(/submit_envision rejected[\s\S]*duplicate id "originate"/);

    // The phase did NOT advance: no artifact, no extra commit, no hooks.
    expect(existsSync(join(dir, ENVISION_ARTIFACT_RELPATH))).toBe(false);
    expect(gitOut(dir, "rev-list", "--count", "HEAD")).toBe("1");
    expect(onPhaseCompleted).not.toHaveBeenCalled();
    expect(decisionSink).not.toHaveBeenCalled();
    expect(detectPhase(createFsArtifactProbe(dir))).toBe("envision");
  });
});

// ─── AC2: a valid submit — harness-owned write + commit + hooks ──────────────

describe("submit_envision on a valid payload (AC2) — the harness writes, commits, and reports", () => {
  it("writes product/index.yaml (round-tripping the submission), commits it, and fires the hooks", async () => {
    const dir = await makeEnvisionRepo();
    const onPhaseCompleted = vi.fn();
    const decisionSink = vi.fn();
    const tool = createEnvisionSubmitTool({
      now: () => FIXED_NOW,
      onPhaseCompleted,
      decisionSink,
    });
    const payload = validPayload();

    const result = await tool.execute("t1", payload, undefined, undefined, ctxFor(dir));

    // Success content summarizes what was written.
    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain(ENVISION_ARTIFACT_RELPATH);
    expect(text).toContain(ENVISION_COMMIT_MESSAGE);
    expect(result.details).toEqual({
      phase: "envision",
      artifactRelPath: ENVISION_ARTIFACT_RELPATH,
      commitMessage: ENVISION_COMMIT_MESSAGE,
    });

    // The artifact parses as YAML and round-trips the submitted structure in
    // the split-mode product/index.yaml shape.
    const raw = await readFile(join(dir, ENVISION_ARTIFACT_RELPATH), "utf8");
    const parsed = parse(raw);
    expect(parsed.schema).toBe("v1");
    expect(parsed.personas).toEqual(payload.personas);
    expect(parsed.product.problem).toBe(payload.problem);
    expect(parsed.product.goals).toEqual(payload.goals);
    expect(parsed.product.mvp_boundary).toEqual(payload.mvp_boundary);
    expect(parsed.product.layers).toEqual(payload.layers);
    expect(parsed.product.activities).toEqual(payload.activities);

    // The commit is REAL: git log shows it, the file is tracked, tree is clean.
    expect(gitOut(dir, "rev-list", "--count", "HEAD")).toBe("2");
    expect(gitOut(dir, "log", "-1", "--pretty=%s")).toBe(ENVISION_COMMIT_MESSAGE);
    expect(gitOut(dir, "ls-files").split("\n")).toContain(ENVISION_ARTIFACT_RELPATH);
    expect(gitOut(dir, "status", "--porcelain")).toBe("");

    // Hooks fired exactly once, with the phase id + payload and the
    // DecisionEntry-shaped record (injected clock — deterministic).
    expect(onPhaseCompleted).toHaveBeenCalledTimes(1);
    expect(onPhaseCompleted).toHaveBeenCalledWith("envision", payload);
    expect(decisionSink).toHaveBeenCalledTimes(1);
    expect(decisionSink).toHaveBeenCalledWith({
      id: `envision-${FIXED_NOW}`,
      phase: "envision",
      decision: ENVISION_DECISION_TEXT,
      at: FIXED_NOW,
    } satisfies DecisionEntry);

    // The artifact probe now sees product/index.yaml: the run has moved
    // beyond envision (the v1 registry has no later phase yet, by design).
    expect(createFsArtifactProbe(dir).hasProductIndex()).toBe(true);
  });

  it("serializeEnvisionYaml is canonical: fixed key order, optional fields omitted when absent", () => {
    const { goals: _goals, ...core } = validPayload();
    const text = serializeEnvisionYaml(core as EnvisionSubmission);
    const parsed = parse(text);
    expect(Object.keys(parsed)).toEqual(["schema", "personas", "product"]);
    expect(Object.keys(parsed.product)).toEqual([
      "problem",
      "mvp_boundary",
      "layers",
      "activities",
    ]);
    // The first activity carries no description — the key is omitted, not null.
    expect("description" in parsed.product.activities[0]).toBe(false);
    expect(parsed.product.activities[1].description).toBeDefined();
  });

  it("the HARNESS drives git (injected runner sees add → commit; never the model's git tool)", async () => {
    const dir = await makeEnvisionRepo();
    const gitCalls: Array<[string, string[], string]> = [];
    const exec: SubmitGitRunner = async (subcommand, args, cwd) => {
      gitCalls.push([subcommand, args, cwd]);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const tool = createEnvisionSubmitTool({ now: () => FIXED_NOW, exec });

    await tool.execute("t1", validPayload(), undefined, undefined, ctxFor(dir));

    expect(gitCalls).toEqual([
      ["add", [ENVISION_ARTIFACT_RELPATH], dir],
      ["commit", ["-m", ENVISION_COMMIT_MESSAGE], dir],
    ]);
  });

  it("a failing harness-side commit surfaces actionably and fires NO hooks", async () => {
    const dir = await makeEnvisionRepo();
    const onPhaseCompleted = vi.fn();
    const decisionSink = vi.fn();
    const exec: SubmitGitRunner = async (subcommand) =>
      subcommand === "commit"
        ? { exitCode: 128, stdout: "", stderr: "fatal: unable to write commit" }
        : { exitCode: 0, stdout: "", stderr: "" };
    const tool = createEnvisionSubmitTool({
      now: () => FIXED_NOW,
      exec,
      onPhaseCompleted,
      decisionSink,
    });

    await expect(
      tool.execute("t1", validPayload(), undefined, undefined, ctxFor(dir)),
    ).rejects.toThrow(/git commit.*failed[\s\S]*unable to write commit/);
    expect(onPhaseCompleted).not.toHaveBeenCalled();
    expect(decisionSink).not.toHaveBeenCalled();
  });
});

// ─── AC3: guard interplay — submit_envision is the ONLY artifact path ────────

describe("guard interplay (AC3) — raw writes are vetoed; submit_envision is the one path", () => {
  const envision = getPhaseSpec("envision");

  it("the guard's pure core denies every raw route to product/index.yaml", () => {
    for (const event of [
      { toolName: "write", input: { path: "product/index.yaml", content: "product: {}" } },
      { toolName: "edit", input: { path: "product/index.yaml", edits: [] } },
      { toolName: "git", input: { subcommand: "add", args: ["product/index.yaml"], cwd: "/proj" } },
      { toolName: "bash", input: { command: "echo x > product/index.yaml" } },
    ]) {
      const verdict = evaluatePhaseToolCall(envision, "/proj", event);
      expect(verdict).toMatchObject({ block: true });
      expect(verdict?.reason).toContain("envision phase may only write within");
    }
  });

  it("…while the completion tool is exempt", () => {
    expect(
      evaluatePhaseToolCall(envision, "/proj", {
        toolName: SUBMIT_ENVISION_TOOL_NAME,
        input: validPayload(),
      }),
    ).toBeUndefined();
  });

  it("end-to-end in a temp repo: the guard handler vetoes the raw write and redirects to submit_envision, which then succeeds", async () => {
    const dir = await makeEnvisionRepo();
    const guard = toolCallHandlerOf(createPhaseGuardExtension(envision));
    const guardCtx = { cwd: dir } as ExtensionContext;

    // 1. The raw write is vetoed PRE-EXECUTION with a model-readable redirect…
    const vetoed = await guard(
      call("write", { path: "product/index.yaml", content: "product: {}" }),
      guardCtx,
    );
    expect(vetoed).toMatchObject({ block: true });
    expect(vetoed?.reason).toContain("`submit_envision`");
    expect(existsSync(join(dir, ENVISION_ARTIFACT_RELPATH))).toBe(false);

    // 2. …the submit call passes the guard…
    const payload = validPayload();
    expect(await guard(call(SUBMIT_ENVISION_TOOL_NAME, { ...payload }), guardCtx)).toBeUndefined();

    // 3. …and the tool itself completes the phase: artifact written AND committed.
    const decisionSink = vi.fn();
    const tool = createEnvisionSubmitTool({ now: () => FIXED_NOW, decisionSink });
    await tool.execute("t1", payload, undefined, undefined, ctxFor(dir));
    expect(gitOut(dir, "log", "-1", "--pretty=%s")).toBe(ENVISION_COMMIT_MESSAGE);
    expect(gitOut(dir, "ls-files").split("\n")).toContain(ENVISION_ARTIFACT_RELPATH);
    expect(decisionSink).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "envision", decision: ENVISION_DECISION_TEXT }),
    );
  });

  it("a booted envision phase session carries submit_envision as an ACTIVE tool with the guard bound", async () => {
    const dir = await makeEnvisionRepo();
    const { session } = await bootPhaseSession(envision, {
      cwd: dir,
      completion: { now: () => FIXED_NOW },
    });
    try {
      expect(session.getActiveToolNames()).toContain(SUBMIT_ENVISION_TOOL_NAME);
      expect(session.hasExtensionHandlers("tool_call")).toBe(true);
      // The system prompt surfaces the tool so the model knows the ONE path.
      expect([...session.getActiveToolNames()].sort()).toEqual([
        "find",
        "grep",
        "ls",
        "read",
        SUBMIT_ENVISION_TOOL_NAME,
      ]);
    } finally {
      await session.dispose();
    }
  });
});

// ─── factory generality — a later phase is only a schema + writer ────────────

describe("createSubmitTool generality — later phases need only a schema + writer", () => {
  it("a map-phase submit tool works off the same factory with zero submit.ts changes", async () => {
    const dir = await makeEnvisionRepo();
    const MapSchema = Type.Object({
      stories: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    });
    const decisionSink = vi.fn();
    const tool = createSubmitTool({
      spec: { id: "map", completionToolName: "submit_map" },
      schema: MapSchema,
      description: "Submit the story map.",
      serialize: (payload) => stringify({ stories: payload.stories }),
      artifactRelPath: "stories/index.yaml",
      commitMessage: "feat(map): commit story map",
      decisionText: "Committed stories/index.yaml (story map)",
      now: () => FIXED_NOW,
      decisionSink,
    });
    expect(tool.name).toBe("submit_map");

    await tool.execute("t1", { stories: ["story-1"] }, undefined, undefined, ctxFor(dir));

    expect(parse(await readFile(join(dir, "stories/index.yaml"), "utf8"))).toEqual({
      stories: ["story-1"],
    });
    expect(gitOut(dir, "log", "-1", "--pretty=%s")).toBe("feat(map): commit story map");
    expect(decisionSink).toHaveBeenCalledWith({
      id: `map-${FIXED_NOW}`,
      phase: "map",
      decision: "Committed stories/index.yaml (story map)",
      at: FIXED_NOW,
    });
  });

  it("refuses to build a tool for a phase that declares no completion tool", () => {
    expect(() =>
      createSubmitTool({
        spec: { id: "originate", completionToolName: null },
        schema: Type.Object({}),
        description: "n/a",
        serialize: () => "",
        artifactRelPath: "x.yaml",
        commitMessage: "x",
        decisionText: "x",
      }),
    ).toThrow(/originate.*declares no completion tool/);
  });
});
