# SIBYL-004: Narrow git tool (init/add/commit)

## Status

implemented

## Problem

The originate flow needs the agent to `git init` a project, `git add` files, and
`git commit` a README — but giving the agent unrestricted bash access violates the
trust model stated in ADR-002 / the security model ("allow gh via full bash = a
large surface").

## Proposed change

Add a narrow git tool (`apps/harness/src/tools/git.ts`) that:

- Exposes **only** `init`, `add`, `commit` as allowed subcommands.
- Refuses any other subcommand (e.g. `push`, `rm`, `checkout`) **without
  shelling out** — returning `{ exitCode: 1, stdout: "", stderr: "not allowed" }`.
- Returns a structured `GitResult = { exitCode, stdout, stderr }` for every call.
- Is built as **two shapes** so callers can choose the right seam:
  1. `runGit(subcommand, args, cwd) → Promise<GitResult>` — plain function, no Pi
     context needed, usable directly by the engine.
  2. `gitToolDefinition` (a `defineTool(...)` value) / `registerGitTool(pi)` —
     Pi-native so `setActiveTools(["git"])` can gate it at tool granularity.

## Interface implemented

`engine → tools` (`git(args) -> { exitCode, stdout, stderr }`) as specified in
`product-context.yaml#architecture.interfaces`.

## Pi API used

- `defineTool` (named export from `@earendil-works/pi-coding-agent`) — a
  type-inference preservation wrapper that returns `ToolDefinition & AnyToolDefinition`.
- `pi.registerTool(tool: ToolDefinition)` — method on `ExtensionAPI`, registers
  the tool so the LLM can call it.
- TypeBox `Type` (from the `typebox` transitive dep) for the parameter schema.

## No new runtime dependencies

`typebox` is a transitive runtime dep of `@earendil-works/pi-coding-agent`; no
new entries were added to `apps/harness/package.json`.
