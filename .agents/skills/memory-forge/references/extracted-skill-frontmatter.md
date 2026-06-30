# Extracted-skill frontmatter

Schema for the YAML frontmatter at the top of every SKILL.md the forge writes.

## Minimum frontmatter

```yaml
---
name: <kebab-case-slug>
description: <one-line, trigger-phrase-rich, ≤500 chars>
license: <inherited from host project, default Apache-2.0>
version: 0.1.0
metadata:
  origin: memory-forge
  origin_hash: <sha256 of the SKILL.md body at write time>
  source_lessons:
    - project-memory/lesson-learned/YYYY-MM-DD/session-HHMM-slug.md
    - ...
  forged_at: <ISO 8601 timestamp, e.g. 2026-05-23T14:02:00>
  decay_after_days: 90
  pinned: false
---
```

## Field definitions

### `name`
Kebab-case slug. Used as the directory name (`<skill-root>/<name>/`) and as the symlink name in `.claude/skills/<name>` etc. Must not collide with any existing skill in the host project — `apply_forge.sh` enforces this.

### `description`
The string Claude Code (and other agents.md-spec scanners) match against the user's request to decide whether to load the skill. Should be **trigger-phrase-rich** — include the verbs and nouns users naturally say when they want this skill to fire. Hermes's bundled-skill guideline of ≤60 chars is too tight for project-memory-style triggers; aim for ≤500 chars total but front-load the most important triggers.

### `metadata.origin`
Always `memory-forge` for forged skills. The forge will not touch any skill whose `origin` is missing or set to anything else (e.g. a hand-written skill).

### `metadata.origin_hash`
The sha256 of the SKILL.md body (everything below the closing `---` of the frontmatter), computed at write time. Used by `check_human_edit.sh` to detect human edits:

- **Current hash == `origin_hash`** → untouched. The forge may overwrite the body on a future pass (e.g. to widen the umbrella).
- **Current hash != `origin_hash`** → human-edited. The forge **never** overwrites the body. References/ appends are still allowed.

`scripts/record_origin_hash.sh` writes this field on first creation and on any forge-driven body update. Humans should not touch this field manually.

### `metadata.source_lessons`
Paths (relative to project root) of every lesson file that contributed to this skill. Appended-to (not replaced) on every consolidation pass. The history of lessons that built up to this skill is itself useful provenance.

### `metadata.forged_at`
ISO 8601 timestamp of the most recent forge action on this skill. Updated on body rewrites and references appends. Lets `apply_forge.sh` compute "lessons accumulated since last forge" without scanning git history.

### `metadata.decay_after_days`
Default `90`. If `now - forged_at > decay_after_days` and the skill is not pinned, the next forge pass will consider the skill stale and may re-evaluate it (rewrite, prune, or pin). Mirrors hermes-agent's 90-day archive threshold.

### `metadata.pinned`
Default `false`. When `true`:

- The skill bypasses decay (never re-evaluated for staleness).
- The forge refuses to prune it (even into another umbrella's `references/`).
- Body rewrites still respect the `origin_hash` check.

Set `pinned: true` manually when a forged skill is too important to risk re-evaluation. The pinning is sticky — the forge never sets `pinned` back to `false`.

## Example: a freshly-forged umbrella

```yaml
---
name: deploy-coordination
description: "Use when changes touch deploy ordering, asset upload sequencing, or invalidation timing. Trigger on phrases: 'deploy order', 'asset upload', 'cache bust', 'parallel deploy', 'invalidation race'. Forged from 2 recurring sessions where deploy step ordering caused production incidents."
license: Apache-2.0
version: 0.1.0
metadata:
  origin: memory-forge
  origin_hash: 9a3f7c1b2e8d4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a
  source_lessons:
    - project-memory/lesson-learned/2026-04-18/session-1102-asset-race.md
    - project-memory/lesson-learned/2026-05-12/session-1530-deploy-order.md
  forged_at: 2026-05-23T14:02:00
  decay_after_days: 90
  pinned: false
---
```

## How references frontmatter differs

Files under a forged skill's `references/` use a lighter frontmatter — they're not skills themselves, just supporting context that the umbrella skill loads on demand:

```yaml
---
type: lesson-distillation
source_lessons:
  - project-memory/lesson-learned/2026-04-18/session-1102-asset-race.md
forged_at: 2026-05-23T14:02:00
summary: "Asset upload must finish before cache invalidation begins."
---
```

No `origin_hash` here — `references/` files are append-only. The forge may add new references files, but never rewrites an existing one. If a lesson supersedes a prior references file, the forge writes a new references file referencing the old one, rather than mutating history.
