# SIBYL-004 tasks

## Status: done

## Tasks

- [x] Create `apps/harness/src/tools/git.ts`
  - `ALLOWED_SUBCOMMANDS` const (`init`, `add`, `commit`)
  - `isAllowed(cmd)` type-guard
  - `GitResult` interface `{ exitCode, stdout, stderr }`
  - `runGit(subcommand, args, cwd)` — plain async function
    - Refuses disallowed subcommands without shelling out
    - Uses `child_process.execFile` (no new deps)
    - Captures exit code, stdout, stderr on failure
  - `GitToolParams` TypeBox schema (`subcommand` union literal, `args[]`, `cwd`)
  - `gitToolDefinition` via `defineTool(...)` — Pi LLM-callable tool
  - `registerGitTool(pi)` — registers tool on `ExtensionAPI`

- [x] Create `apps/harness/test/git.test.ts`
  - Unit: allowlist enforcement (5 refused-subcommand cases)
  - Integration: `init` + write file + `add .` + `commit` on a real temp dir;
    assert `git log --oneline` shows the commit
  - Integration: commit with nothing staged returns non-zero
  - Contract: `GitResult` schema on allowed result
  - Contract: `GitResult` schema on refused result
  - Contract: Pi `gitToolDefinition.execute()` returns `AgentToolResult` with
    `GitResult` details and text-serialised content

- [x] Create `openspec/changes/SIBYL-004/{proposal.md, tasks.md}`

- [x] oxlint + oxfmt pass on the two new files

- [x] `tsc --noEmit` passes

- [x] `vitest run` — 12/12 tests green (10 git + 2 pre-existing)
