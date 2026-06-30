import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { discoverSkills } from "../src/engine/session";

// The harness package dir. Discovery walks up to the git root to find .agents/skills.
const cwd = fileURLToPath(new URL("..", import.meta.url));

describe("skill discovery (integration)", () => {
  it("resolves aep-* skills from .agents/skills, including aep-envision", async () => {
    const skills = await discoverSkills(cwd);
    const names = skills.map((skill) => skill.name);

    expect(names).toContain("aep-envision");
    expect(names.some((name) => name.startsWith("aep-"))).toBe(true);

    const envision = skills.find((skill) => skill.name === "aep-envision");
    expect(envision?.filePath).toMatch(/\.agents\/skills\/aep-envision\/SKILL\.md$/);
  });
});
