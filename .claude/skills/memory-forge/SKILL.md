---
name: memory-forge
description: "Forge reusable skills from accumulated project-memory lessons. Use when the user wants to consolidate, distill, or extract durable skills out of project-memory/ — turning lessons-learned into agent-loadable skills that prevent the project from repeating its own mistakes. Trigger phrases: 'forge a skill', 'forge memory', 'distill lessons', 'extract skills from memory', 'consolidate project-memory', 'turn lessons into skills', 'evolve our skills', 'memory curator', 'what skill should this become'. Trigger proactively when project-memory wrap-up has produced 3+ new lessons since the last forge, when the user is about to open a PR after several captured lessons, or when a recurring theme emerges across 2+ session files. Reads project-memory/lesson-learned/ (and other subsystems), clusters lessons ≥7 days old, then merges them into umbrella skills under the host project's detected skill-loading path."
license: Apache-2.0
version: 0.1.0
metadata:
  clawdbot:
    emoji: "⚒️"
---

# memory-forge

The curator-side counterpart to [`project-memory`](../project-memory/SKILL.md).

`project-memory` captures lessons. `memory-forge` distills them into reusable, agent-loadable skills that future sessions trigger automatically — so the project actually stops repeating its own mistakes instead of just remembering them in a folder.

A consolidation pass reads `project-memory/lesson-learned/*/session-*.md`, clusters recurring themes, and writes class-level umbrella skills to wherever the host project loads skills from (canonical `skills/<group>/`, flat `.claude/skills/`, Codex `.codex/skills/`, or `.agents/skills/`).

**Core philosophy** (lifted from NousResearch's hermes-agent and held verbatim):

- *Be ACTIVE. A pass that does nothing is a missed learning opportunity — not a neutral outcome.*
- *A collection of hundreds of narrow skills where each one captures one session's specific bug is a FAILURE of the library — not a feature.*

These two opposing pressures together produce class-level skills with rich `references/`, not a flat list of one-shot entries.

## Entry points — pick one and load that workflow

- **Run a forge pass now** ("forge a skill", "distill lessons", "consolidate memory") → [workflows/run-forge.md](workflows/run-forge.md). The main pass: select → cluster → prompt → structured summary → apply.
- **Triggered from project-memory wrap-up** (≥3 new lessons since last forge) → [workflows/on-wrap-up.md](workflows/on-wrap-up.md). Lightweight proactive check.
- **About to open a PR** (`gh pr create` is imminent) → [workflows/on-pr-open.md](workflows/on-pr-open.md). Pre-PR forge pass, commits any extracted skills onto the same branch before the PR opens.
- **A new lesson contradicts an existing extracted skill** → [workflows/reconcile-conflicts.md](workflows/reconcile-conflicts.md). Decide between supersede, narrow, or branch.

## Why this skill exists

Lessons-learned without distillation just become a longer search query. The point is to convert recurring patterns into skills the *next* agent loads automatically — so the project's effective behaviour evolves with what's been learned, instead of relying on every future session to re-search the archive.

NousResearch's [hermes-agent](https://github.com/nousresearch/hermes-agent) solves this with a two-tier loop: a per-turn capture pass plus a periodic curator that runs idle-only and is gated by inactivity. `project-memory` already covers the capture tier in a richer, git-committable shape. This skill is the curator tier — designed to be invoked, not silent, and to leave a paper trail in the repo.

## The forge pass at a glance

```
project-memory/lesson-learned/*/session-*.md
              │
              ▼  (1) select_lessons.sh — pure shell, no LLM
   age ≥ 7 days?  ── no ──▶ skip (still settling)
              │ yes
              ▼  (2) cluster_lessons.sh — qmd semantic neighborhoods, fallback to tags
       lesson clusters
              │
              ▼  (3) forge prompt — see references/extraction-prompts.md
       ## Structured summary block
       {consolidations, new_skills, prunings}
              │
              ▼  (4) detect_target.sh — where does this project load skills?
       host project skill path
              │
              ▼  (5) check_human_edit.sh — origin-hash protection
       any human-edited target?  ── yes ──▶ skip body; references/ append only
              │ no
              ▼  (6) apply_forge.sh — idempotent writes
       new SKILL.md / appended references/ / demoted narrow skills
              │
              ▼  (7) record_origin_hash.sh — stamps origin on new files
       provenance + decay metadata in frontmatter
```

Every step has a dedicated script under `scripts/`. The forge prompt itself is the only LLM-driven step — everything around it is pure shell so the pipeline is dry-runnable, idempotent, and rolls back cleanly.

## Output target detection (key design point)

The forge writes to wherever the host project's agents actually load skills from. `scripts/detect_target.sh` checks in order:

1. **Canonical layout** — `skills/` is a real dir AND `.claude/skills` symlinks into it → write to `<root>/skills/<group>/<name>/`.
2. **Flat Claude Code** — `.claude/skills/` is a real dir → write to `.claude/skills/<name>/`.
3. **Codex** — `.codex/skills/` is a real dir → write to `.codex/skills/<name>/`.
4. **agents.md-spec** — `.agents/skills/` is a real dir → write to `.agents/skills/<name>/`.
5. **Nothing yet** — create `.claude/skills/<name>/` (most universal default for Claude Code).

Full detection logic, including the canonical-vs-symlink rules, is in [references/target-detection.md](references/target-detection.md).

## Extracted-skill frontmatter

Every skill the forge writes carries provenance + decay metadata:

```yaml
metadata:
  origin: memory-forge
  origin_hash: <sha256 of SKILL.md body at creation>
  source_lessons:
    - project-memory/lesson-learned/2026-05-20/session-1432-cache-bust.md
    - project-memory/lesson-learned/2026-05-21/session-0912-cache-deploy.md
  forged_at: 2026-05-23T14:02:00
  decay_after_days: 90
  pinned: false
```

If the user hand-edits an extracted skill, the body's hash diverges from `origin_hash` — `check_human_edit.sh` then flags it as user-modified and the forge **never** overwrites it. (New lessons can still get appended to `references/`, but the SKILL.md body is sacred once a human has touched it.)

Schema details in [references/extracted-skill-frontmatter.md](references/extracted-skill-frontmatter.md).

## Triggers

| Trigger | Mechanism |
|---|---|
| Explicit user request | Trigger phrases in the description: "forge a skill", "distill lessons", "extract skills from memory", "consolidate project-memory". |
| Wrap-up proactive | `project-memory`'s `wrap-up-session.md` appends a step: if ≥3 new lessons since last forge, suggest running it. |
| Age pre-filter | `select_lessons.sh` skips lessons younger than 7 days — pure shell, zero LLM cost. |
| On PR open | `workflows/on-pr-open.md` runs the forge before `gh pr create` and commits any extracted skills onto the same branch. `references/trigger-recipes.md` includes a sample CI workflow that posts the structured summary as a PR comment. |

The skill is **invoke-driven**, not silent. A forge pass always produces either a `## Structured summary` block with applied actions or an explicit "nothing to consolidate yet — N lessons under the 7-day pre-filter, M clusters too small" report. There is no third "did nothing, said nothing" outcome.

## Bundled scripts

All scripts resolve their own `$SKILL_DIR` from the symlinked discovery path, mirror the pattern from `project-memory`, and are tool-agnostic shell. Invoke as `bash "$SKILL_DIR/scripts/<name>.sh"`.

- [`scripts/detect_target.sh`](scripts/detect_target.sh) — prints the absolute path where extracted skills should be written.
- [`scripts/select_lessons.sh`](scripts/select_lessons.sh) — enumerates eligible lesson files (≥7 days old). Pure shell.
- [`scripts/cluster_lessons.sh`](scripts/cluster_lessons.sh) — clusters lessons by recurring theme. Uses `qmd` if present, falls back to tag/title heuristics.
- [`scripts/apply_forge.sh`](scripts/apply_forge.sh) — parses a `## Structured summary` block from stdin and applies it. Idempotent.
- [`scripts/record_origin_hash.sh`](scripts/record_origin_hash.sh) — stamps the `origin_hash` field after a new write.
- [`scripts/check_human_edit.sh`](scripts/check_human_edit.sh) — compares current SKILL.md hash against the recorded `origin_hash`. Exits 0 = untouched, 1 = human-edited.

## Cross-agent note

Like `project-memory`, this skill runs the same way across Claude Code, Codex, and Pi because everything is shell scripts + tool-agnostic markdown. The auto-detection step (`detect_target.sh`) finds the right output path for each harness.

## References (load only when needed)

- [references/extraction-prompts.md](references/extraction-prompts.md) — the verbatim opposing-pressure prompts ("be ACTIVE" + "flat list = failure"), with scoring rubric. Load before running the forge pass.
- [references/target-detection.md](references/target-detection.md) — detailed rules for finding the host project's skill-loading path.
- [references/structured-summary-schema.md](references/structured-summary-schema.md) — the required output schema (`consolidations`, `new_skills`, `prunings`). Load when authoring or parsing the structured summary.
- [references/extracted-skill-frontmatter.md](references/extracted-skill-frontmatter.md) — field definitions for the frontmatter the forge writes.
- [references/trigger-recipes.md](references/trigger-recipes.md) — sample CI snippets, `gh pr create` wrappers, cron entries. Copy-paste integrations.

## Don't

- **Don't run silently.** Either apply a structured summary or report why the pass was a no-op (e.g. "all 4 candidate lessons are <7 days old"). A silent no-op is the failure mode this skill is designed to fight.
- **Don't mint a new top-level skill for every lesson.** Prefer appending to an existing umbrella's `references/`. A flat list of one-shot skills is the other failure mode.
- **Don't touch hand-edited skills.** If `check_human_edit.sh` returns 1, the SKILL.md body is off-limits forever. References/ appends are still fine.
- **Don't forge from fresh lessons** (<7 days). They're still settling. The pre-filter exists for a reason — overriding it on every pass defeats the consolidation signal.
- **Don't promote forged skills into a user's global `~/.claude/skills/`.** This skill is project-scoped by design, just like its capture-side counterpart.
