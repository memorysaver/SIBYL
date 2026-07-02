# AEP conduct mechanisms — code-controlled workflow, prompt-compiled judgment

**Status:** accepted · **Date:** 2026-07-02 · **Driver:** user directive (stability-first refinement of the determinism mandate)

## Context

SIBYL conducts the AEP workflow through the Pi agent SDK. The open question: per phase, do we
(a) programmatically inject an agent skill, or (b) design the prompt directly and let the
program control the workflow itself? The user's answer: **stability is the core; the AEP skills
inform the design, but SIBYL is not required to reference them at runtime.**

A review of the AEP workflow skills (`.claude/skills/aep-*`) shows they interleave two kinds of
content:

1. **Procedure** — phase sequences, file writes, git command blocks, validation loops.
   `aep-build` is a 13-phase state machine written in prose (955 lines); `aep-envision`
   Phase 1 ends with YAML serialization + commit instructions. On Claude Code the MODEL
   executes this prose — that is the primary instability source.
2. **Judgment** — interview questions, framing heuristics, decomposition principles,
   classification rubrics. This is what models are actually good at.

## Decision

**Split them. Procedure → TypeScript. Judgment → prompt-compiled briefs.**

- **Procedure is code (the AepFlow kernel):** phase sequencing (`detectPhase` artifact
  predicates), artifact serialization + writes + commits (typed `submit_<phase>` tools),
  worktree + process lifecycle, validation/retry loops. The model never executes a prose
  state machine.
- **Judgment is a compiled brief:** authored as markdown files bundled in the CLI (the
  skill-file FORMAT is kept — it's a good authoring/versioning unit, content derived from the
  AEP skills), but **injected by code via `appendSystemPrompt`** when the harness boots the
  phase session — never a runtime discovery/invocation bet. Rationale: Pi's skill mechanism
  lists skills in an Agent-Skills XML block and relies on the MODEL choosing to read
  `SKILL.md` — two nondeterministic steps for content that is MANDATORY for a phase the
  harness has already chosen. When the phase is known, inject the full brief.
- **`skillsOverride` narrowing stays as defense-in-depth** (it keeps foreign/user-project
  skills OUT of the prompt), but it is no longer the delivery mechanism for phase conduct.

### The determinism ladder (choose per phase; escalate on observed instability)

1. **Compiled brief** — full phase brief in the system prompt. Baseline for every phase.
2. **Typed completion tool** — TypeBox schema = the phase's output contract; the harness
   writes/commits the artifact. Every artifact-producing phase.
3. **Programmatic step nudges** — the harness watches the event stream for stall/drift and
   injects a code-built corrective via `session.steer()`.
4. **Scripted micro-turns** — the harness drives each step as its own `prompt()` with a
   code-built prompt; the model only answers. For phases that stay unstable, and for
   non-interactive worker internals.

### Per-phase mechanism matrix

| AEP phase | Interaction | Mechanism | Completion |
| --- | --- | --- | --- |
| originate | cockpit interview | compiled brief (migrating from skill-discovery: SIBYL-017) | commit detection (v0) → typed submit later |
| envision | cockpit interview | compiled brief + narrowing | `submit_envision` (typed, SIBYL-014) |
| map | interview + auto decomposition | compiled brief; decomposition may run as a headless worker on ladder-4 micro-turns | `submit_map` (typed: stories/waves/gates) |
| scaffold | mostly procedural | mostly CODE — harness executes scaffold steps; model only for choices (ladder 4) | harness-verified artifacts |
| story build (L4/L6) | headless worker | worker process with compiled build brief; harness owns the verify loop; micro-turns per task where needed | typed task/story completion + green tests |
| wrap / reflect | mixed | code for archive/cleanup/sync; brief for classification judgment | typed classification submit |

## Spawn architecture (story workers)

AEP's executor matrix (tmux/cmux, claude-bg, codex-exec) existed for Claude Code / Codex host
compatibility. SIBYL is Pi-SDK-native, so it implements its **own executor with the same
shape** — referencing the tmux / Claude Code native-background-agent style:

- **Phase conductor sessions** (originate/envision/map/scaffold conversations): in-process
  `AgentSession`, cockpit-owned, chat-visible, one at a time.
- **Story workers (L4+): one independent OS process per story** — `sibyl worker --story <id>
  --worktree <path>` running a headless Pi session. Crash-isolated from the cockpit; spawn /
  liveness-probe / kill / `git worktree add+remove` are all harness-owned TypeScript.
- **Observable + attachable:** each worker appends to its own Pi session JSONL + a signals
  file; the cockpit renders a workers view and can **attach** — switch over to a live view of
  that worker's stream (the tmux "switch to the pane" / Claude Code "view the background
  agent" affordance) — and steer through a control channel routed to `session.steer()`.
- Post-spawn liveness probe + orphan re-adoption carry over from AEP process learnings.

## Consequences

- SIBYL-014 (typed submit) unaffected — it IS ladder rung 2.
- SIBYL-015's `SKILL.md` + narrowing tests stay valid (the file is the authoring format; the
  narrowing is leak defense). Only the DELIVERY changes.
- New **SIBYL-017**: `bootPhaseSession` reads the phase's brief body and appends it to the
  system prompt; skill discovery is no longer load-bearing for phase conduct. SIBYL-016
  (cockpit envision) rides on it.
- L4/L6 story decomposition must spec the worker process + attach view per this doc.
