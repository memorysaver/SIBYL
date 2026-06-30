# memory-forge

Forge reusable skills from accumulated [`project-memory`](../project-memory/) lessons.

`project-memory` captures lessons. `memory-forge` distills them into agent-loadable skills the next session triggers automatically — so the project's effective behaviour evolves with what's been learned, instead of relying on every future session to re-search the archive.

Designed as the curator-side counterpart to `project-memory`'s capture side. Inspired by the periodic-curator pass in NousResearch's [hermes-agent](https://github.com/nousresearch/hermes-agent), with two design choices lifted verbatim:

- **Be ACTIVE.** A consolidation pass that produces nothing is a missed learning opportunity, not a neutral outcome.
- **A flat list of one-shot skills is a failure, not a feature.** The target shape of the skill library is class-level umbrella skills with rich `references/`.

These opposing pressures stabilise the library shape over many passes.

## Usage

Trigger phrases the skill responds to:

- "forge a skill from these lessons"
- "distill lessons"
- "extract skills from memory"
- "consolidate project-memory"
- "evolve our skills"

Or, proactively:

- After `project-memory`'s wrap-up workflow finishes with ≥3 new lessons since the last forge.
- Before `gh pr create` is called — the on-PR-open workflow commits any extracted skills onto the same branch.

## What it does

1. Reads `project-memory/lesson-learned/*/session-*.md` (and other subsystems under `project-memory/`).
2. Pre-filters by age: only lessons ≥7 days old are eligible (younger ones are "still settling").
3. Clusters by recurring theme using `qmd` (falls back to tag/title heuristics).
4. Runs an LLM forge prompt that must produce a `## Structured summary` block with `consolidations`, `new_skills`, and `prunings` arrays.
5. Detects the host project's skill-loading path (canonical / flat / Codex / agents).
6. Applies the structured summary idempotently. Hand-edited skills are protected by an `origin_hash` check — the forge never overwrites a human's edits to the SKILL.md body.

The whole pipeline is shell + one LLM call, so it dry-runs cleanly and is safe to re-run.

## Files

- `SKILL.md` — the entry-point skill definition the agent loads.
- `workflows/` — runnable workflows for each entry point.
- `references/` — schemas, prompts, integration recipes (load only when needed).
- `scripts/` — executable shell helpers.

## Spec

This skill follows the open [Agent Skills spec](https://agentskills.io/home).
