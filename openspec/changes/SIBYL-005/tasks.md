# SIBYL-005 — Tasks

- [x] Verify the real Pi 0.80.2 API: `pi.appendEntry(customType, data)` signature, its
      wiring to `SessionManager.appendCustomEntry`, and that custom entries are excluded
      from the LLM context (`buildSessionContext` ignores `type: "custom"`).
- [x] Implement `apps/harness/src/memory/decisions.ts` — `DecisionEntry` type +
      `appendDecision(pi, entry)` + `recallDecisions(source)` (two functions only).
- [x] Unit test: `appendDecision` persists via `pi.appendEntry`; `recallDecisions`
      round-trips (single + ordered multiple) on an in-memory session (AC1, AC2).
- [x] Integration test: a decision appended in one session is recalled by a fresh boot
      over the same session ("session_start" restore) (AC2).
- [x] Excluded-from-context test: `buildSessionContext(getEntries())` contains none of an
      appended decision's payload (AC3).
- [x] `openspec/changes/SIBYL-005/{proposal.md, tasks.md}`.
- [x] Run vitest green; lint/format only own files; commit; rebase on `origin/main`;
      open PR; merge if all 3 criteria green.
