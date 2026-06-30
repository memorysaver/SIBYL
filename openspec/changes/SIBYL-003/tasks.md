# SIBYL-003 — Tasks

- [x] Read the merged foundations in the worktree (`engine/seam.ts`,
      `engine/state-machine.ts`, `engine/session.ts`, `engine/extension.ts`,
      `tools/git.ts`, `memory/decisions.ts`), `docs/research/pi-integration.md`,
      and `product-context.yaml` (`originate-run` sequence + SIBYL-003 story).
- [x] Verify the real Pi API against `@earendil-works/pi-coding-agent@0.80.2`:
      `AgentSession.prompt` / `subscribe` / `setActiveToolsByName`; the
      `AgentEvent` / `AgentSessionEvent` shapes (`tool_execution_start/update/end`,
      `message_update` carrying `assistantMessageEvent` with `text_delta`);
      `createReadOnlyTools` = `read`/`grep`/`find`/`ls`.
- [x] `engine/originate.ts` — `createOriginateCore()` returning the
      `EngineRunCore` (`startForm` / `runToDecision` / `complete`); a narrow
      `OriginateSession` port + `defaultConnect` (boots a session with the git
      tool bound); the imagine prompt builder; the Pi-event → `progress` mapping;
      engine-side README write; commit-gate decision; `complete` git
      init/add/commit via `runGit`. No change to `seam.ts` / `state-machine.ts`.
- [x] Gate tools read-only + git via `setActiveToolsByName(["read","grep",
    "find","ls","git"])` before the imagine turn (so the engine, not the agent,
      writes the file). No new runtime deps.
- [x] `test/originate.test.ts` — a scripted `OriginateSession` double emitting
      the REAL `AgentSessionEvent` shapes drives the real core: README written
      from the imagine output (criterion 1), `tool_execution_*` / `message_update`
      → ordered `progress` events (criterion 2), commit-gate `decision_requested`
      at completion (criterion 3); plus `complete` git commit, fallback README,
      `run_failed{agent}` classification, and the prompt builder.
- [x] Green: `tsc --noEmit` (check-types) and `vitest run` (41 tests) pass.
- [x] Lint/format clean on the changed files (oxlint + oxfmt), no unrelated repo
      files reformatted.
- [x] Rebase on `origin/main`, re-run tests, open PR with evidence, merge if all
      three acceptance criteria are objectively green.

## Honest gaps

- The live-model run is NOT exercised in CI (no model creds; out of scope per the
  testing approach). The scripted double drives the real `EngineRunCore` logic
  with the verified Pi event shapes; criterion 1's README is produced from the
  scripted imagine output, not a live model.
