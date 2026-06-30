/**
 * SIBYL-004: Narrow git tool (init / add / commit).
 *
 * Exposes ONLY the three subcommands the trust model allows. Any other
 * subcommand is refused **without shelling out** — no arbitrary bash surface.
 *
 * Two public shapes:
 *  (a) `runGit(subcommand, args, cwd)` — plain async function the engine can
 *      call directly (no Pi context needed).
 *  (b) `gitToolDefinition` / `registerGitTool(pi)` — the Pi `ToolDefinition`
 *      so `setActiveTools` can gate it at tool granularity.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ─── allowlist ────────────────────────────────────────────────────────────────

const ALLOWED_SUBCOMMANDS = ["init", "add", "commit"] as const;
type AllowedSubcommand = (typeof ALLOWED_SUBCOMMANDS)[number];

function isAllowed(cmd: string): cmd is AllowedSubcommand {
  return (ALLOWED_SUBCOMMANDS as readonly string[]).includes(cmd);
}

// ─── result type ──────────────────────────────────────────────────────────────

/** Structured result returned for every git invocation (allowed or refused). */
export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// ─── plain function (engine surface) ─────────────────────────────────────────

const execFileAsync = promisify(execFile);

/**
 * Run a narrow git subcommand against `cwd`.
 *
 * Refuses (without executing) any subcommand not in {init, add, commit} and
 * returns `exitCode: 1` with a descriptive `stderr` message.
 */
export async function runGit(subcommand: string, args: string[], cwd: string): Promise<GitResult> {
  if (!isAllowed(subcommand)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `Subcommand "${subcommand}" is not allowed. ` +
        `Permitted: ${ALLOWED_SUBCOMMANDS.join(", ")}.`,
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync("git", [subcommand, ...args], {
      cwd,
      encoding: "utf8",
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err: unknown) {
    // execFile rejects with an error that carries `code`, `stdout`, `stderr`
    // when the child exits with a non-zero code.
    if (err !== null && typeof err === "object") {
      const e = err as {
        code?: number | null;
        stdout?: string;
        stderr?: string;
      };
      return {
        exitCode: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? String(err),
      };
    }
    return { exitCode: 1, stdout: "", stderr: String(err) };
  }
}

// ─── Pi tool definition (LLM surface) ────────────────────────────────────────

const GitToolParams = Type.Object({
  subcommand: Type.Union([Type.Literal("init"), Type.Literal("add"), Type.Literal("commit")], {
    description: "Git subcommand to run. Only init, add, and commit are permitted.",
  }),
  args: Type.Array(Type.String(), {
    default: [],
    description: 'Additional arguments forwarded to git (e.g. ["." ] for add).',
  }),
  cwd: Type.String({
    description: "Absolute path of the working directory for the git command.",
  }),
});

/**
 * Pi `ToolDefinition` for the narrow git tool.
 *
 * Use `pi.registerTool(gitToolDefinition)` or `registerGitTool(pi)` to
 * bind it into a session. `setActiveTools` gates at tool granularity — include
 * `"git"` to enable, exclude to disable.
 */
export const gitToolDefinition = defineTool({
  name: "git",
  label: "Git",
  description:
    "Run a narrow git command (init, add, or commit) against a given working " +
    "directory. Returns { exitCode, stdout, stderr }. Only the three listed " +
    "subcommands are permitted; any other is refused without execution.",
  parameters: GitToolParams,
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const result = await runGit(params.subcommand, params.args, params.cwd);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      details: result,
    };
  },
});

/**
 * Register the narrow git tool on a Pi extension API.
 *
 * Typically called inside an `ExtensionFactory`:
 * ```ts
 * export function createSibylEngineExtension(): ExtensionFactory {
 *   return (pi) => {
 *     registerGitTool(pi);
 *   };
 * }
 * ```
 */
export function registerGitTool(pi: ExtensionAPI): void {
  pi.registerTool(gitToolDefinition);
}
