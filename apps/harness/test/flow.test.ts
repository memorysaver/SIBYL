import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  COCKPIT_TOOLS,
  PHASE_REGISTRY,
  type ArtifactProbe,
  type PhaseId,
  type PhaseSpec,
  bootPhaseSession,
  createFsArtifactProbe,
  createPhaseGuardExtension,
  detectPhase,
  evaluatePhaseToolCall,
  getPhaseSpec,
  loadPhaseBrief,
} from "../src/engine/flow";
import { SIBYL_BUNDLED_SKILLS_DIR, SIBYL_PERSONA, discoverSkills } from "../src/engine/session";

/**
 * SIBYL-013 — the AEP orchestration kernel. These tests prove the kernel's
 * determinism HEADLESSLY (no live model), per the story's acceptance criteria:
 *
 *  AC1  detectPhase is a pure function of artifacts (fake probes + a real
 *       temp-dir git repo).
 *  AC2  a phase session's assembled system prompt surfaces ONLY that phase's
 *       skill, and its active tools equal exactly the phase's allowlist.
 *  AC3  the guard blocks out-of-allowlist writes with a structured, actionable
 *       reason and lets in-allowlist calls through (handler-contract matrix),
 *       and is genuinely bound into a booted phase session.
 *  AC4  the kernel generalizes: a new phase is ONLY a registry entry (+ its
 *       bundled skill) — no kernel changes.
 */

// ─── helpers ─────────────────────────────────────────────────────────────────

/** A trivially fakeable ArtifactProbe: two booleans in, deterministic out. */
function fakeProbe(state: { committedReadme: boolean; productIndex: boolean }): ArtifactProbe {
  return {
    hasCommittedReadme: () => state.committedReadme,
    hasProductIndex: () => state.productIndex,
  };
}

/**
 * Capture the `tool_call` handler a guard factory registers — the exact
 * handler contract a real Pi session invokes pre-execution. Only `pi.on` is
 * faked; the guard uses nothing else.
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

/** A type-faithful ToolCallEvent for the handler contract. */
function call(toolName: string, input: Record<string, unknown>): ToolCallEvent {
  return { type: "tool_call", toolCallId: "t1", toolName, input } as ToolCallEvent;
}

/** The only piece of ExtensionContext the guard reads is `cwd`. */
const PROJ = "/proj";
const guardCtx = { cwd: PROJ } as ExtensionContext;

// A throwaway "user project" OUTSIDE the SIBYL git root, with a DECOY project
// skill planted in `.agents/skills/` — default discovery walks this git root
// and WOULD surface it, so any phase session that doesn't is proving the
// narrowing, not an absence of skills.
let userProject: string;

beforeAll(async () => {
  userProject = await mkdtemp(join(tmpdir(), "sibyl-flow-"));
  execFileSync("git", ["init", "-q"], { cwd: userProject });
  const decoyDir = join(userProject, ".agents", "skills", "user-decoy");
  await mkdir(decoyDir, { recursive: true });
  await writeFile(
    join(decoyDir, "SKILL.md"),
    "---\nname: user-decoy\ndescription: A user-project skill that must NOT leak into a phase session.\n---\n\nDecoy body.\n",
  );
});

afterAll(async () => {
  if (userProject) {
    await rm(userProject, { recursive: true, force: true });
  }
});

// ─── phase registry v1 ───────────────────────────────────────────────────────

describe("PHASE_REGISTRY v1", () => {
  it("declares originate then envision — order is load-bearing for detectPhase", () => {
    expect(PHASE_REGISTRY.map((spec) => spec.id)).toEqual(["originate", "envision"]);

    const originate = getPhaseSpec("originate");
    expect(originate.skillName).toBe("sibyl-originate");
    expect(originate.toolAllowlist).toEqual([...COCKPIT_TOOLS]);
    expect(originate.pathAllowlist).toEqual(["README.md", ".git"]);
    expect(originate.completionToolName).toBeNull();

    const envision = getPhaseSpec("envision");
    expect(envision.skillName).toBe("sibyl-envision");
    expect(envision.completionToolName).toBe("submit_envision");
    // The submit tool owns the artifact write, so no direct write paths.
    expect(envision.pathAllowlist).toEqual([]);
    expect(envision.toolAllowlist).toContain("submit_envision");
  });
});

// ─── AC1: detectPhase ────────────────────────────────────────────────────────

describe("detectPhase (AC1) — pure artifact routing", () => {
  it("routes to originate whenever there is no committed README", () => {
    expect(detectPhase(fakeProbe({ committedReadme: false, productIndex: false }))).toBe(
      "originate",
    );
    // Declared order wins even for nonsensical artifact combinations.
    expect(detectPhase(fakeProbe({ committedReadme: false, productIndex: true }))).toBe(
      "originate",
    );
  });

  it("routes to envision for a committed README with no product/index.yaml", () => {
    expect(detectPhase(fakeProbe({ committedReadme: true, productIndex: false }))).toBe("envision");
  });

  it("throws (rather than misroutes) when the run is beyond the registered phases", () => {
    expect(() => detectPhase(fakeProbe({ committedReadme: true, productIndex: true }))).toThrow(
      /no phase entry condition matched.*originate, envision/,
    );
  });

  it("is deterministic: same probe, same answer, every time", () => {
    const probe = fakeProbe({ committedReadme: true, productIndex: false });
    const answers = new Set(Array.from({ length: 25 }, () => detectPhase(probe)));
    expect([...answers]).toEqual(["envision"]);
  });

  it("routes a REAL temp-dir git repo by its committed artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sibyl-flow-repo-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      const probe = createFsArtifactProbe(dir);

      // Empty repo (no commits): originate.
      expect(detectPhase(probe)).toBe("originate");

      // A WRITTEN-but-uncommitted README does not advance the phase.
      await writeFile(join(dir, "README.md"), "# Goal\n");
      expect(detectPhase(probe)).toBe("originate");

      // Committed README, no product/index.yaml: envision.
      execFileSync("git", ["add", "README.md"], { cwd: dir });
      execFileSync(
        "git",
        ["-c", "user.email=sibyl@test", "-c", "user.name=SIBYL", "commit", "-q", "-m", "docs: add README"],
        { cwd: dir },
      );
      expect(detectPhase(probe)).toBe("envision");

      // Both artifacts present: beyond the v1 registry.
      await mkdir(join(dir, "product"));
      await writeFile(join(dir, "product", "index.yaml"), "product: {}\n");
      expect(() => detectPhase(probe)).toThrow(/no phase entry condition matched/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ─── AC2: bootPhaseSession narrowing ─────────────────────────────────────────

describe("bootPhaseSession (AC2) — one skill, exact tools", () => {
  it("control: WITHOUT narrowing, the user project's decoy skill IS discovered", async () => {
    const names = (await discoverSkills(userProject)).map((skill) => skill.name);
    expect(names).toContain("user-decoy");
    expect(names).toContain("sibyl-originate");
  });

  it("originate session surfaces ONLY sibyl-originate and exactly the cockpit tools", async () => {
    const spec = getPhaseSpec("originate");
    const { session, loader } = await bootPhaseSession(spec, { cwd: userProject });

    try {
      // The loader's narrowed skill set: exactly the phase skill.
      expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["sibyl-originate"]);

      // The ASSEMBLED system prompt's Agent-Skills block surfaces only it —
      // the user project's git-root skill does NOT leak in.
      const prompt = session.systemPrompt;
      expect(prompt).toContain("<name>sibyl-originate</name>");
      expect(prompt).not.toContain("user-decoy");

      // Active tools equal EXACTLY the phase allowlist.
      expect([...session.getActiveToolNames()].sort()).toEqual([...spec.toolAllowlist].sort());

      // SIBYL-017 ordering: persona → phase role line → compiled brief body.
      const appended = loader.getAppendSystemPrompt();
      expect(appended[0]).toBe(SIBYL_PERSONA);
      expect(appended[1]).toBe(spec.promptBrief);
      // The sibyl-originate SKILL.md BODY is injected verbatim — the model
      // never has to notice/read the skill file (a distinctive body line).
      expect(appended[2]).toContain("you run git, never the user");
      expect(prompt).toContain("you run git, never the user");
    } finally {
      await session.dispose();
    }
  });

  it("envision session: only sibyl-envision, no skill leak, read-only tools + submit_envision", async () => {
    const spec = getPhaseSpec("envision");
    const { session, loader } = await bootPhaseSession(spec, { cwd: userProject });

    try {
      // The sibyl-envision SKILL.md ships with SIBYL-015: the narrowed set is
      // EXACTLY the phase skill — never the decoy, never another phase's skill.
      expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["sibyl-envision"]);
      const prompt = session.systemPrompt;
      expect(prompt).not.toContain("user-decoy");
      expect(prompt).not.toContain("sibyl-originate");

      // `submit_envision` (SIBYL-014) is built by the registry entry's
      // completionToolFactory and registered by bootPhaseSession, so the
      // active tools are the read-only set PLUS the typed completion tool.
      expect([...session.getActiveToolNames()].sort()).toEqual([
        "find",
        "grep",
        "ls",
        "read",
        "submit_envision",
      ]);

      // SIBYL-017 AC1+AC3 ordering: persona → phase role line → compiled
      // brief body — the sibyl-envision SKILL.md BODY, injected verbatim.
      const appended = loader.getAppendSystemPrompt();
      expect(appended[0]).toBe(SIBYL_PERSONA);
      expect(appended[1]).toBe(spec.promptBrief);
      expect(appended[2]).toContain("Complete ONLY by calling `submit_envision`");
      // Frontmatter is stripped: the injected entry carries no YAML keys.
      expect(appended[2]).not.toContain("name: sibyl-envision");
      expect(appended[2]).not.toContain("description:");

      // The ASSEMBLED prompt carries the brief body itself — not just the
      // Agent-Skills name listing — and no frontmatter leaks in.
      expect(prompt).toContain("Complete ONLY by calling `submit_envision`");
      expect(prompt).not.toContain("name: sibyl-envision");
    } finally {
      await session.dispose();
    }
  });
});

// ─── SIBYL-017: loadPhaseBrief — deterministic brief injection ───────────────

describe("loadPhaseBrief (SIBYL-017) — the compiled phase brief", () => {
  it("returns the bundled skill's BODY with the frontmatter stripped", () => {
    const body = loadPhaseBrief("sibyl-envision");

    // Substance is present (distinctive body lines)…
    expect(body).toContain("Complete ONLY by calling `submit_envision`");
    expect(body).toContain("The README IS the envision context");
    // …frontmatter is not: no delimiter, no YAML keys.
    expect(body.startsWith("---")).toBe(false);
    expect(body).not.toContain("name: sibyl-envision");
    expect(body).not.toContain("description:");
  });

  it("resolves from an EXTRA trusted root (bundled roots win in declared order)", async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), "sibyl-brief-roots-"));
    try {
      await mkdir(join(skillsDir, "sibyl-extra"));
      await writeFile(
        join(skillsDir, "sibyl-extra", "SKILL.md"),
        "---\nname: sibyl-extra\ndescription: Extra-root brief.\n---\n\nExtra-root brief body.\n",
      );
      expect(loadPhaseBrief("sibyl-extra", [skillsDir])).toBe("Extra-root brief body.");
    } finally {
      await rm(skillsDir, { recursive: true, force: true });
    }
  });

  it("does NOT resolve briefs from untrusted locations (only the given roots are searched)", () => {
    // The user project's decoy skill exists on disk, but its root is never trusted.
    expect(() => loadPhaseBrief("user-decoy")).toThrow(/no SKILL\.md found/);
  });

  it("a missing brief throws an explicit error naming the skill and the searched roots", () => {
    expect(() => loadPhaseBrief("sibyl-nonexistent")).toThrow(
      /loadPhaseBrief: no SKILL\.md found for skill "sibyl-nonexistent"/,
    );
    expect(() => loadPhaseBrief("sibyl-nonexistent")).toThrow(SIBYL_BUNDLED_SKILLS_DIR);

    const extraRoot = "/tmp/sibyl-extra-trusted-root";
    expect(() => loadPhaseBrief("sibyl-nonexistent", [extraRoot])).toThrow(extraRoot);
  });

  it("bootPhaseSession REFUSES to boot a phase whose brief is missing (no silent fallback)", async () => {
    const briefless: PhaseSpec<"briefless"> = {
      id: "briefless",
      entryCondition: () => true,
      skillName: "sibyl-has-no-skill-md",
      toolAllowlist: ["read"],
      pathAllowlist: [],
      promptBrief: "Test-only phase with no bundled SKILL.md.",
      completionToolName: null,
    };
    await expect(bootPhaseSession(briefless, { cwd: userProject })).rejects.toThrow(
      /no SKILL\.md found for skill "sibyl-has-no-skill-md"/,
    );
  });
});

// ─── AC3: the invariant guard ────────────────────────────────────────────────

describe("phase guard (AC3) — tool_call veto", () => {
  const originate = getPhaseSpec("originate");
  const envision = getPhaseSpec("envision");
  const originateGuard = toolCallHandlerOf(createPhaseGuardExtension(originate));
  const envisionGuard = toolCallHandlerOf(createPhaseGuardExtension(envision));

  describe("allows in-allowlist calls through", () => {
    it.each([
      ["write README.md", call("write", { path: "README.md", content: "# Goal" })],
      ["write ./README.md (normalized)", call("write", { path: "./README.md", content: "x" })],
      ["edit README.md", call("edit", { path: "README.md", edits: [] })],
      ["git init", call("git", { subcommand: "init", args: [], cwd: PROJ })],
      ["git add README.md", call("git", { subcommand: "add", args: ["README.md"], cwd: PROJ })],
      [
        "git commit -m (message is not a path)",
        call("git", { subcommand: "commit", args: ["-m", "docs: add README"], cwd: PROJ }),
      ],
      ["read anything (read-only)", call("read", { path: "product-context.yaml" })],
      ["grep anywhere (read-only)", call("grep", { pattern: "x", path: "." })],
    ])("originate: %s", async (_label, event) => {
      expect(await originateGuard(event, guardCtx)).toBeUndefined();
    });

    it("envision: the phase's completion tool is exempt (it owns the artifact write)", async () => {
      const event = call("submit_envision", { framing: "…" });
      expect(await envisionGuard(event, guardCtx)).toBeUndefined();
    });
  });

  describe("blocks out-of-allowlist and unverifiable calls with a structured reason", () => {
    it.each([
      ["write product-context.yaml", call("write", { path: "product-context.yaml", content: "" })],
      ["edit an absolute path outside the project", call("edit", { path: "/etc/passwd", edits: [] })],
      ["write escaping the project via ..", call("write", { path: "../escape.md", content: "" })],
      ["write with no verifiable path", call("write", { content: "no path field" })],
      ["git add . (wider than the allowlist)", call("git", { subcommand: "add", args: ["."], cwd: PROJ })],
      [
        "git add product-context.yaml",
        call("git", { subcommand: "add", args: ["product-context.yaml"], cwd: PROJ }),
      ],
      [
        "git commit with an out-of-allowlist pathspec",
        call("git", { subcommand: "commit", args: ["-m", "msg", "product-context.yaml"], cwd: PROJ }),
      ],
      ["git push (unknown subcommand)", call("git", { subcommand: "push", args: ["origin"], cwd: PROJ })],
      ["bash (unknown mutating tool → default-deny)", call("bash", { command: "rm -rf ." })],
    ])("originate: %s", async (_label, event) => {
      const result = await originateGuard(event, guardCtx);
      expect(result).toMatchObject({ block: true });
      expect(result?.reason).toMatch(/^originate phase may only write within: README\.md, \.git\./);
    });

    it("names the offending target so the model can self-correct", async () => {
      const result = await originateGuard(
        call("write", { path: "product-context.yaml", content: "" }),
        guardCtx,
      );
      expect(result?.reason).toContain('Blocked write targeting "product-context.yaml"');
    });

    it("git metadata writes outside the project cwd are blocked too", async () => {
      const result = await originateGuard(
        call("git", { subcommand: "init", args: [], cwd: "/elsewhere" }),
        guardCtx,
      );
      expect(result).toMatchObject({ block: true });
    });

    it("envision: a direct artifact write is blocked and redirected to the submit tool", async () => {
      const result = await envisionGuard(
        call("write", { path: "product/index.yaml", content: "" }),
        guardCtx,
      );
      expect(result).toMatchObject({ block: true });
      expect(result?.reason).toContain("envision phase may only write within: (no direct file writes)");
      expect(result?.reason).toContain("`submit_envision`");
    });
  });

  it("evaluatePhaseToolCall (the guard's pure core) agrees with the handler", () => {
    expect(
      evaluatePhaseToolCall(originate, PROJ, { toolName: "write", input: { path: "README.md" } }),
    ).toBeUndefined();
    expect(
      evaluatePhaseToolCall(originate, PROJ, {
        toolName: "write",
        input: { path: "product-context.yaml" },
      }),
    ).toMatchObject({ block: true });
  });

  it("integration: the guard is genuinely bound into a booted phase session", async () => {
    const { session } = await bootPhaseSession(getPhaseSpec("originate"), { cwd: userProject });
    try {
      expect(session.hasExtensionHandlers("tool_call")).toBe(true);
    } finally {
      await session.dispose();
    }
  });
});

// ─── AC4: the kernel generalizes ─────────────────────────────────────────────

describe("kernel generality (AC4) — a new phase is only a registry entry", () => {
  // A dummy test-only phase, written WITHOUT touching any kernel code: routing,
  // narrowing, and the guard all work off the same PhaseSpec shape.
  const dummy: PhaseSpec<"map"> = {
    id: "map",
    entryCondition: (probe) => probe.hasCommittedReadme() && probe.hasProductIndex(),
    skillName: "sibyl-map",
    toolAllowlist: ["read", "write"],
    pathAllowlist: ["stories/"],
    promptBrief: "You are in SIBYL's MAP phase (test dummy).",
    completionToolName: "submit_map",
  };

  it("detectPhase routes to the dummy phase from the extended registry", () => {
    const registry: ReadonlyArray<PhaseSpec<PhaseId | "map">> = [...PHASE_REGISTRY, dummy];
    expect(detectPhase(fakeProbe({ committedReadme: true, productIndex: true }), registry)).toBe(
      "map",
    );
    // …and the v1 routes still hold in declared order.
    expect(detectPhase(fakeProbe({ committedReadme: false, productIndex: false }), registry)).toBe(
      "originate",
    );
    expect(detectPhase(fakeProbe({ committedReadme: true, productIndex: false }), registry)).toBe(
      "envision",
    );
  });

  it("the guard enforces the dummy phase's allowlist with zero kernel changes", async () => {
    const guard = toolCallHandlerOf(createPhaseGuardExtension(dummy));
    expect(await guard(call("write", { path: "stories/story-1.yaml", content: "" }), guardCtx)).toBeUndefined();
    const blocked = await guard(call("write", { path: "README.md", content: "" }), guardCtx);
    expect(blocked).toMatchObject({ block: true });
    expect(blocked?.reason).toMatch(/^map phase may only write within: stories\//);
    expect(await guard(call("submit_map", { stories: [] }), guardCtx)).toBeUndefined();
  });

  it("boots a dummy phase session whose bundled skill ships from an additional skills dir", async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), "sibyl-flow-skills-"));
    try {
      await mkdir(join(skillsDir, "sibyl-map"));
      await writeFile(
        join(skillsDir, "sibyl-map", "SKILL.md"),
        "---\nname: sibyl-map\ndescription: Test-only map-phase conductor for the AC4 generality proof.\n---\n\nDummy map skill body.\n",
      );

      const { session, loader } = await bootPhaseSession(dummy, {
        cwd: userProject,
        additionalSkillPaths: [skillsDir],
      });
      try {
        expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["sibyl-map"]);
        expect(session.systemPrompt).toContain("<name>sibyl-map</name>");
        expect(session.systemPrompt).not.toContain("user-decoy");
        expect([...session.getActiveToolNames()].sort()).toEqual(["read", "write"]);

        // SIBYL-017: the dummy phase's brief BODY is injected from the extra
        // trusted root — persona → role line → body, with zero kernel changes.
        const appended = loader.getAppendSystemPrompt();
        expect(appended[0]).toBe(SIBYL_PERSONA);
        expect(appended[1]).toBe(dummy.promptBrief);
        expect(appended[2]).toBe("Dummy map skill body.");
      } finally {
        await session.dispose();
      }
    } finally {
      await rm(skillsDir, { recursive: true, force: true });
    }
  });
});
