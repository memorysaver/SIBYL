/**
 * SIBYL-004 tests: narrow git tool (init / add / commit).
 *
 * Three test groups matching the story verification plan:
 *  - Unit:       allowlist enforcement (disallowed subcommand refused, not run)
 *  - Integration: init + add + commit on a real temp repo, asserting a commit exists
 *  - Contract:   git tool result schema { exitCode, stdout, stderr }
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { gitToolDefinition, runGit, type GitResult } from "../src/tools/git";

const execFileAsync = promisify(execFile);

// ─── helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "sibyl-git-test-"));
}

async function removeTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── Unit: allowlist enforcement ──────────────────────────────────────────────

describe("runGit — allowlist enforcement (unit)", () => {
  it("refuses 'push' without executing git", async () => {
    const dir = await makeTempDir();
    try {
      const result = await runGit("push", [], dir);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/not allowed/);
      expect(result.stderr).toMatch(/push/);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("refuses 'rm' without executing git", async () => {
    const dir = await makeTempDir();
    try {
      const result = await runGit("rm", ["somefile"], dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/not allowed/);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("refuses 'checkout' without executing git", async () => {
    const dir = await makeTempDir();
    try {
      const result = await runGit("checkout", ["-b", "other"], dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/not allowed/);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("refuses empty-string subcommand without executing git", async () => {
    const dir = await makeTempDir();
    try {
      const result = await runGit("", [], dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/not allowed/);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("refuses an arbitrary shell string without executing git", async () => {
    const dir = await makeTempDir();
    try {
      const result = await runGit("push origin main", [], dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/not allowed/);
    } finally {
      await removeTempDir(dir);
    }
  });
});

// ─── Integration: init + add + commit on a real temp repo ────────────────────

describe("runGit — init / add / commit integration", () => {
  it("initialises a repo, stages a file, and creates a commit", async () => {
    const dir = await makeTempDir();
    try {
      // 1. git init
      const initResult = await runGit("init", [], dir);
      expect(initResult.exitCode).toBe(0);

      // 2. Write a file to commit
      const filePath = path.join(dir, "README.md");
      await fs.writeFile(filePath, "# SIBYL test\n", "utf8");

      // 3. git add .
      const addResult = await runGit("add", ["."], dir);
      expect(addResult.exitCode).toBe(0);

      // 4. Configure author identity in the repo so commit succeeds
      await execFileAsync("git", ["config", "user.name", "SIBYL Test"], { cwd: dir });
      await execFileAsync("git", ["config", "user.email", "test@sibyl.local"], { cwd: dir });

      // 5. git commit
      const commitResult = await runGit("commit", ["-m", "test: initial commit"], dir);
      expect(commitResult.exitCode).toBe(0);

      // 6. Assert a commit exists in the repo
      const { stdout: logOut } = await execFileAsync("git", ["log", "--oneline"], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(logOut.trim()).not.toBe("");
      expect(logOut).toMatch(/test: initial commit/);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("returns non-zero exitCode when git fails (e.g. commit with nothing staged)", async () => {
    const dir = await makeTempDir();
    try {
      await runGit("init", [], dir);
      await execFileAsync("git", ["config", "user.name", "SIBYL Test"], { cwd: dir });
      await execFileAsync("git", ["config", "user.email", "test@sibyl.local"], { cwd: dir });
      // Commit without staging anything — git should exit non-zero
      const result = await runGit("commit", ["-m", "empty"], dir);
      expect(result.exitCode).not.toBe(0);
    } finally {
      await removeTempDir(dir);
    }
  });
});

// ─── Contract: result schema { exitCode, stdout, stderr } ────────────────────

describe("GitResult schema (contract)", () => {
  function isGitResult(v: unknown): v is GitResult {
    if (typeof v !== "object" || v === null) return false;
    const r = v as Record<string, unknown>;
    return (
      typeof r["exitCode"] === "number" &&
      typeof r["stdout"] === "string" &&
      typeof r["stderr"] === "string"
    );
  }

  it("allowed subcommand result conforms to { exitCode, stdout, stderr }", async () => {
    const dir = await makeTempDir();
    try {
      const result = await runGit("init", [], dir);
      expect(isGitResult(result)).toBe(true);
      expect(result.exitCode).toBe(0);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("refused subcommand result conforms to { exitCode, stdout, stderr }", async () => {
    const dir = await makeTempDir();
    try {
      const result = await runGit("push", [], dir);
      expect(isGitResult(result)).toBe(true);
      expect(result.exitCode).toBe(1);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("Pi tool definition execute returns AgentToolResult with GitResult details", async () => {
    const dir = await makeTempDir();
    try {
      // Invoke the Pi tool's execute directly (no Pi session needed)
      const agentResult = await gitToolDefinition.execute(
        "test-call-id",
        { subcommand: "init", args: [], cwd: dir },
        undefined,
        undefined,
        // ExtensionContext is not needed by this tool — pass a minimal stub
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any,
      );

      // AgentToolResult: { content: TextContent[], details: GitResult }
      expect(Array.isArray(agentResult.content)).toBe(true);
      expect(agentResult.content.length).toBeGreaterThan(0);

      const first = agentResult.content[0];
      expect(first).toBeDefined();
      // TextContent has type: "text" and text: string
      if (first && first.type === "text") {
        const parsed: unknown = JSON.parse(first.text);
        expect(isGitResult(parsed)).toBe(true);
      }

      // details carries the structured result
      const details: unknown = agentResult.details;
      expect(isGitResult(details)).toBe(true);
      if (isGitResult(details)) {
        expect(details.exitCode).toBe(0);
      }
    } finally {
      await removeTempDir(dir);
    }
  });
});
