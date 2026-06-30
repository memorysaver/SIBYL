# SIBYL-001 — Engine bootstrap: embed Pi SDK + bind SIBYL engine-extension

## What

Add a new `apps/harness` workspace that boots a Pi `AgentSession` for a given
`cwd`, bound to a minimal SIBYL engine-extension, with skills from
`.agents/skills` discoverable by the booted session.

- `apps/harness/src/engine/extension.ts` — `createSibylEngineExtension()`, a
  minimal `ExtensionFactory` stub that binds into the session (registers one
  marker command so the binding is observable).
- `apps/harness/src/engine/session.ts` — `bootSession(cwd)` configures a
  `DefaultResourceLoader` (SIBYL engine-extension factory + `getAgentDir()`),
  reloads it, and calls `createAgentSession`; `discoverSkills(cwd)` returns the
  skills the loader resolves.
- Pinned to `@earendil-works/pi-coding-agent@0.80.2`, TypeScript ~5.9,
  `@types/node` ~22.19, Node `>=22.19` — kept OUT of the shared Bun catalog
  (the catalog pins `typescript ^6`, which clashes with Pi's TS 5.9.x).

## Why

This is the foundation for every later layer: it proves SDK boot + extension
load + skill discovery against the real Pi package before any engine seam,
renderer, tool, or memory work is built on top.

## Non-goals

- No EngineEvent / EngineCommand seam or run/phase state machine (SIBYL-002).
- No renderer / pi-tui UI (SIBYL-006+).
- No narrow git tool (SIBYL-004) or decision-memory pass-through (SIBYL-005).
- No real model prompting, persistence/resume, or RPC mode.

## Acceptance criteria

1. `apps/harness` builds and runs under Node `>=22.19` with
   `@earendil-works/pi-coding-agent@0.80.2` (out of the shared catalog).
2. `createAgentSession` returns a session bound to the SIBYL engine-extension
   via `extensionFactories` (proven by the marker command being registered).
3. A discovery check confirms `aep-*` skills resolve from `.agents/skills`
   (specifically `aep-envision`).
