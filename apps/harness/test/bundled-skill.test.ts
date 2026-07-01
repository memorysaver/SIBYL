import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COCKPIT_ORIGINATE_POINTER } from "../src/engine/conversation";
import {
  SIBYL_BUNDLED_SKILLS_DIR,
  SIBYL_PERSONA,
  bootSession,
  discoverSkills,
} from "../src/engine/session";

/**
 * SIBYL-012 — the guided-originate conductor now ships as a BUNDLED Pi skill
 * (`apps/harness/skills/sibyl-originate/SKILL.md`) discovered via
 * `additionalSkillPaths`, not a hardcoded prompt string. These tests prove the
 * MECHANISM headlessly (NO live model):
 *
 *  1. the bundled skill resolves from an ARBITRARY cwd (a throwaway user project
 *     outside the SIBYL repo) — which git-root walking alone would miss;
 *  2. it is surfaced into the system prompt (via `formatSkillsForPrompt`);
 *  3. the thin cockpit pointer activates it while {@link SIBYL_PERSONA} stays first.
 *
 * The live-behavior confirmation (interview → draft → commit) is the orchestrator's
 * job after merge.
 */

// A throwaway "user project" OUTSIDE the SIBYL git root: an empty, freshly-`git
// init`ed temp dir. Default skill discovery walks THIS git root for `.agents/skills`
// and finds none — so any `sibyl-*` skill that still resolves here can only come
// from the harness-bundled `additionalSkillPaths`.
let userProject: string;

beforeAll(async () => {
  userProject = await mkdtemp(join(tmpdir(), "sibyl-cockpit-"));
  execFileSync("git", ["init", "-q"], { cwd: userProject });
});

afterAll(async () => {
  if (userProject) {
    await rm(userProject, { recursive: true, force: true });
  }
});

describe("bundled sibyl-originate skill (SIBYL-012)", () => {
  it("resolves from an arbitrary cwd — proving it is bundled, not git-root-walked", async () => {
    const skills = await discoverSkills(userProject);
    const names = skills.map((skill) => skill.name);

    // Found regardless of cwd — via the package-relative bundled-skills dir.
    expect(names).toContain("sibyl-originate");

    // Control: the repo's own `.agents/skills/*` are NOT reachable from this
    // isolated temp git root, so a bare git-root walk would surface neither the
    // aep-* skills NOR the originate skill. That the originate skill IS present
    // proves it came from `additionalSkillPaths`, not the cwd.
    expect(names).not.toContain("aep-envision");

    const originate = skills.find((skill) => skill.name === "sibyl-originate");
    expect(originate?.filePath).toMatch(/skills\/sibyl-originate\/SKILL\.md$/);
    // ...and it lives under the harness-owned, install-location-relative dir.
    expect(originate?.filePath.startsWith(SIBYL_BUNDLED_SKILLS_DIR)).toBe(true);
    // Model-invocable (not disabled), so the model can read + follow it.
    expect(originate?.disableModelInvocation).toBe(false);
  });

  it("surfaces the skill into the system prompt (name + description)", async () => {
    const skills = await discoverSkills(userProject);
    const promptFragment = formatSkillsForPrompt(skills);

    // The skill appears in the Agent-Skills XML the SDK injects into the prompt.
    expect(promptFragment).toContain("<name>sibyl-originate</name>");
    // A stable phrase from the SKILL.md description (not brittle exact prose).
    expect(promptFragment).toContain("guided-originate conductor");
  });

  it("keeps SIBYL_PERSONA first and activates the flow via the thin pointer", async () => {
    const { session, loader } = await bootSession(userProject, {
      appendSystemPrompt: [COCKPIT_ORIGINATE_POINTER],
    });

    try {
      const appended = loader.getAppendSystemPrompt();

      // Persona identity is prepended ahead of any flow brief (SIBYL-011 intact).
      expect(appended[0]).toBe(SIBYL_PERSONA);
      // The cockpit pointer is present, and it activates the bundled skill by name
      // (the SUBSTANCE lives in the SKILL.md, not this string).
      expect(appended).toContain(COCKPIT_ORIGINATE_POINTER);
      expect(COCKPIT_ORIGINATE_POINTER).toContain("sibyl-originate");

      // The same booted loader discovers the bundled skill for this cwd.
      const names = loader.getSkills().skills.map((skill) => skill.name);
      expect(names).toContain("sibyl-originate");
    } finally {
      await session.dispose();
    }
  });
});
