# The SIBYL Phase Pattern

**Status:** accepted (user-ratified) · **Date:** 2026-07-02 · **Companion:** `aep-conduct-mechanisms.md` (the mechanism decision this pattern packages)

Every AEP phase SIBYL conducts — originate, envision, map, scaffold, story-build, wrap/reflect —
is **one instantiation of the same template**. New phases add a registry entry, a brief, and a
submit schema. They never add kernel machinery. Story specs for later layers MUST reference this
doc instead of re-deriving the design.

## The template (one `PhaseSpec` registry entry per phase)

| Slot | Owner | What it fixes |
| --- | --- | --- |
| `entryCondition` — pure artifact predicates over cwd | **code** | WHEN the phase runs (detect-state routing / resume) |
| `brief` — bundled md file, body **compiled into the system prompt** | **judgment** | HOW to think (content derived from the corresponding AEP skill) |
| `toolAllowlist` + `pathAllowlist` (tool_call guard, veto with reason) | **code** | WHAT the model may touch |
| `submit_<phase>` — TypeBox schema = the phase's output contract; the **harness** serializes, writes, commits, advances | **code** | WHEN the phase is DONE, and the artifact itself |

## Invariants (never vary)

1. **Fresh session per phase** — context control by construction.
2. **Brief always injected** (`appendSystemPrompt`) — runtime skill discovery is never load-bearing; `skillsOverride` narrowing remains only as leak defense.
3. **Guard always on** — default-deny unknown write-capable tools; completion tool exempt.
4. **The model never free-writes control-plane artifacts** — typed submit is the only path.
5. **Harness owns all lifecycle** — sessions, worktrees, worker processes, retries.

## The 3 variation axes (registry config, never new machinery)

1. **Determinism-ladder rung** — 1 compiled brief → 2 typed completion → 3 programmatic
   `steer()` nudges → 4 scripted micro-turns. Escalate per phase on observed instability.
2. **Session locality** — in-process conductor session (chat-visible in the cockpit) vs
   **independent worker process** (`sibyl worker`, crash-isolated, cockpit can attach + steer).
3. **Artifact target** — what the submit tool writes.

## Canonical instantiations

| Phase | Rung | Locality | Submit target |
| --- | --- | --- | --- |
| originate | 1–2 | in-process conductor | `README.md` (commit-detect v0 → typed submit later) |
| envision | 1–2 | in-process conductor | `product/index.yaml` (`submit_envision`, SIBYL-014) |
| map | 2–3 | in-process conductor (+ optional headless decomposition sub-step at rung 4) | stories/waves/gates (`submit_map`) |
| scaffold | 4 (mostly code; model only for choices) | in-process | scaffold tree (harness-verified) |
| story build (L4/L6) | 2–4 internally | **worker process** per story | code + tests + PR (typed task/story completion) |
| wrap / reflect | 2 | in-process | archive/cleanup is pure code; classification via typed submit |

## Mechanical proof of the pattern

- SIBYL-013 AC4: registering a new phase = registry entry only (dummy-phase test, merged `be97c74`).
- SIBYL-014: `createSubmitTool` is a generic factory; envision is instance #1.
- SIBYL-015: the brief md is the authoring unit; injected-brief voice (merged `9d2741c`).
- SIBYL-017: injection replaces discovery as the delivery mechanism.

**Consequence for planning:** L1 proves the template vertically for one phase (envision).
Each later layer is mostly instantiation — brief md + submit schema + registry entry — plus that
layer's unique code (L2: legibility renderers; L3: scaffold executor; L4: the worker-process
host; L6: parallel workers + attach UI).
