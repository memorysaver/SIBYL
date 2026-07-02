import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COCKPIT_ORIGINATE_POINTER } from "../src/engine/conversation";
import { bootPhaseSession, getPhaseSpec } from "../src/engine/flow";
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

// A throwaway "user project" OUTSIDE the SIBYL git root: a freshly-`git init`ed
// temp dir. Default skill discovery walks THIS git root for `.agents/skills`
// and finds only the planted DECOY — so any `sibyl-*` skill that resolves here
// can only come from the harness-bundled `additionalSkillPaths`, and the decoy
// gives the phase-narrowing test (SIBYL-015) a user-project skill that MUST
// stay out of a phase session's prompt.
let userProject: string;

beforeAll(async () => {
  userProject = await mkdtemp(join(tmpdir(), "sibyl-cockpit-"));
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

/**
 * SIBYL-015 — the envision conductor ships as a SECOND bundled skill
 * (`apps/harness/skills/sibyl-envision/SKILL.md`). Same mechanism-level proof
 * as above (NO live model), plus the AEP-kernel binding:
 *
 *  1. dropping a new skill DIR into the bundled skills dir is discovered with
 *     ZERO harness code changes (cwd-independent, alongside sibyl-originate);
 *  2. it surfaces into the prompt via `formatSkillsForPrompt`;
 *  3. an ENVISION phase session (booted through the SIBYL-013 kernel's
 *     `bootPhaseSession` narrowing) surfaces ONLY `sibyl-envision` — the
 *     originate skill and user-project skills are absent;
 *  4. the skill's contract: README = envision context, ask-before-write
 *     interview, propose the framing, complete ONLY via `submit_envision`.
 */
describe("bundled sibyl-envision skill (SIBYL-015)", () => {
  it("resolves from an arbitrary cwd alongside sibyl-originate — zero harness code changes", async () => {
    const skills = await discoverSkills(userProject);
    const names = skills.map((skill) => skill.name);

    // BOTH bundled skills surface from the same package-relative dir: adding
    // the envision skill was only a new directory, no session/loader change.
    expect(names).toContain("sibyl-envision");
    expect(names).toContain("sibyl-originate");

    const envision = skills.find((skill) => skill.name === "sibyl-envision");
    expect(envision?.filePath).toMatch(/skills\/sibyl-envision\/SKILL\.md$/);
    // ...and it lives under the harness-owned, install-location-relative dir.
    expect(envision?.filePath.startsWith(SIBYL_BUNDLED_SKILLS_DIR)).toBe(true);
    // Model-invocable (not disabled): it is the ONE skill of its phase session.
    expect(envision?.disableModelInvocation).toBe(false);
  });

  it("surfaces the skill into the system prompt (name + description)", async () => {
    const skills = await discoverSkills(userProject);
    const promptFragment = formatSkillsForPrompt(skills);

    expect(promptFragment).toContain("<name>sibyl-envision</name>");
    // A stable phrase from the SKILL.md description (not brittle exact prose).
    expect(promptFragment).toContain("envision conductor");
  });

  it("an ENVISION phase session surfaces ONLY sibyl-envision in its Agent-Skills block", async () => {
    // Boot through the SIBYL-013 kernel's own narrowing path: the envision
    // PhaseSpec names `sibyl-envision`, and bootPhaseSession filters discovery
    // down to exactly that skill from harness-trusted roots.
    const { session, loader } = await bootPhaseSession(getPhaseSpec("envision"), {
      cwd: userProject,
    });

    try {
      // The narrowed skill set is EXACTLY the phase skill.
      expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["sibyl-envision"]);

      // The ASSEMBLED prompt's Agent-Skills block surfaces only it: the other
      // bundled skill AND the user project's git-root decoy are absent.
      const prompt = session.systemPrompt;
      expect(prompt).toContain("<name>sibyl-envision</name>");
      expect(prompt).not.toContain("<name>sibyl-originate</name>");
      expect(prompt).not.toContain("user-decoy");
    } finally {
      await session.dispose();
    }
  });

  it("instructs README-as-context, ask-before-write, propose, and completion ONLY via submit_envision", async () => {
    const skills = await discoverSkills(userProject);
    const envision = skills.find((skill) => skill.name === "sibyl-envision");

    // Frontmatter description names the completion tool and forbids the raw write.
    expect(envision?.description).toContain("submit_envision");
    expect(envision?.description).toContain("never write product/index.yaml directly");

    // The body carries the conductor's four invariants (stable phrases).
    const body = await readFile(
      join(SIBYL_BUNDLED_SKILLS_DIR, "sibyl-envision", "SKILL.md"),
      "utf8",
    );
    expect(body).toContain("The README IS the envision context");
    expect(body).toContain("Ask-before-write");
    expect(body).toContain("Propose the framing compactly");
    expect(body).toContain("Complete ONLY by calling `submit_envision`");
    expect(body).toMatch(/NEVER write\s+`product\/index\.yaml`/);
  });
});
