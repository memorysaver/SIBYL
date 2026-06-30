# SIBYL-005 — Decision-memory pass-through (appendDecision / recallDecisions)

## Why

Layer 0's success criterion requires capturing ≥1 decision-memory entry per run. The
`memory` module (`product-context.yaml` → `architecture.modules.memory`) is, in v0, a
**thin pass-through** to Pi's session: it must persist a captured human decision and read
prior decisions back on resume. It also names the future **L5 swap seam** (pluggable
backend: mgrep / MITS) **without** introducing an abstraction layer now.

## What changes

`apps/harness/src/memory/decisions.ts` — exactly **two functions** (no `MemoryEntry`
interface/module until L5):

- `appendDecision(pi, entry)` wraps `pi.appendEntry('sibyl-decision', entry)`.
- `recallDecisions(source)` reads the session's `sibyl-decision` entries back via
  `source.getEntries()` (accepts the full `SessionManager` or the read-only
  `ctx.sessionManager` an extension receives on `session_start`).

`DecisionEntry` shape (`architecture.domain_model.DecisionEntry`):
`{ id: string; phase: string; decision: string; at: number }`. `at` is passed in — pure
logic, no `Date.now()`.

## Verified Pi API (`@earendil-works/pi-coding-agent@0.80.2`)

- `ExtensionAPI.appendEntry<T>(customType: string, data?: T): void` — doc: "Append a custom
  entry to the session for state persistence (**not sent to LLM**)." Wires to
  `SessionManager.appendCustomEntry(customType, data)`, producing a
  `CustomEntry { type: "custom", customType, data, id, parentId, timestamp }`.
- `SessionManager.getEntries(): SessionEntry[]` (also on `ReadonlySessionManager` =
  `ctx.sessionManager`) returns those entries.
- **Excluded-from-LLM-context** is verified behaviorally: the exported
  `buildSessionContext(entries)` (the function that builds what is sent to the model)
  ignores `type: "custom"` entries — `CustomEntry` doc: "Does NOT participate in LLM
  context (ignored by buildSessionContext)."

## Acceptance criteria

1. `appendDecision` persists a `DecisionEntry` via `pi.appendEntry`.
2. `recallDecisions` returns prior entries on a fresh session (read back from the session).
3. Entries are excluded from the LLM context.

## Out of scope

- Any pluggable memory backend / `MemoryEntry` abstraction (L5).
- Deciding _what_ to capture (the engine's job, SIBYL-002/003).
- Cross-process disk-resume of session entries (Pi does not synchronously flush custom
  entries before `dispose`; v0 treats the in-process session as the store — see Notes).
