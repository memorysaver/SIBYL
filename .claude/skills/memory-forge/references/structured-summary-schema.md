# Structured summary schema

The forge prompt MUST end with a `## Structured summary` markdown section that conforms to this schema. `scripts/apply_forge.sh` parses it. Anything outside the schema is treated as analysis and ignored at apply time.

## Top-level shape

```markdown
## Structured summary

```yaml
consolidations:
  - <consolidation entry>
new_skills:
  - <new skill entry>
prunings:
  - <pruning entry>
```
```

A YAML fenced block inside the `## Structured summary` section. All three arrays are required keys (use `[]` if empty). Empty everywhere is allowed only when the pass also includes a top-level explanation of why (see [extraction-prompts.md](extraction-prompts.md)).

## `consolidations[]` — merge lessons into an existing umbrella

Append one or more lesson files to an existing umbrella skill's `references/` directory.

```yaml
- target_skill: cache-invalidation       # existing umbrella SKILL.md (relative to host's skill root)
  references_filename: 2026-05-deploy-cache-busts.md
  source_lessons:
    - project-memory/lesson-learned/2026-05-20/session-1432-cache-bust.md
    - project-memory/lesson-learned/2026-05-21/session-0912-cache-deploy.md
  summary: "Cache invalidation must run AFTER asset upload, not in parallel."
  rationale: |
    Both sessions independently hit the same race condition.
    Adding to the existing cache-invalidation umbrella rather than creating a new
    skill, because the umbrella already covers the cache lifecycle.
```

- `target_skill` is the slug of an existing skill in the host's detected skill root. The forge fails the entry (and reports it) if the target doesn't exist.
- `references_filename` is the new file created under `<target_skill>/references/`. Conventional shape: `<YYYY-MM>-<short-topic>.md`.
- `source_lessons` are paths to the lesson files this entry distills. Used for provenance + traceability.
- `summary` is a one-sentence distillation that gets injected at the top of the new references file.
- `rationale` is free text explaining the choice — why merge here vs. create new. Helps the next forge pass avoid second-guessing.

## `new_skills[]` — create a new umbrella

Mint a new class-level umbrella when no existing skill covers the theme and ≥2 lessons share it.

```yaml
- name: deploy-coordination
  description: |
    Use when changes touch deploy ordering, asset upload sequencing, or
    invalidation timing. Trigger on phrases: 'deploy order', 'asset upload',
    'cache bust', 'parallel deploy'.
  source_lessons:
    - project-memory/lesson-learned/2026-04-18/session-1102-asset-race.md
    - project-memory/lesson-learned/2026-05-12/session-1530-deploy-order.md
  skill_body: |
    # deploy-coordination
    Class-level umbrella for coordinating deploy steps where ordering matters.
    ...
  initial_references:
    - filename: 2026-04-asset-upload-race.md
      summary: "Asset upload must finish before cache invalidation begins."
      source_lessons:
        - project-memory/lesson-learned/2026-04-18/session-1102-asset-race.md
    - filename: 2026-05-deploy-order.md
      summary: "Deploy step order matters under concurrent CI runs."
      source_lessons:
        - project-memory/lesson-learned/2026-05-12/session-1530-deploy-order.md
  rationale: |
    Two unrelated bugs both root-caused to deploy step ordering.
    No existing skill is general enough to absorb both, so this creates
    a class-level umbrella.
```

- `name` is the slug for the new skill. Kebab-case. Must not collide with any existing skill in the host project.
- `description` is the YAML frontmatter description — it drives skill triggering, so it should be trigger-phrase-rich.
- `skill_body` is the markdown body of the new SKILL.md, written by the forge.
- `initial_references` are the references files this new umbrella starts with, derived from `source_lessons`.

The forge MUST stamp `origin: memory-forge`, `origin_hash`, `source_lessons`, `forged_at`, `decay_after_days: 90`, `pinned: false` into the new skill's frontmatter automatically (handled by `scripts/apply_forge.sh` and `scripts/record_origin_hash.sh`). The prompt does not need to emit those fields manually.

## `prunings[]` — demote a narrow skill into a broader one's references/

Remove a previously-forged narrow skill and re-home it as a references file under a broader umbrella.

```yaml
- source_skill: cache-busts-on-deploy        # narrow, previously forged
  into_umbrella: deploy-coordination         # the broader umbrella
  references_filename: 2026-05-cache-busts-on-deploy.md
  rationale: |
    cache-busts-on-deploy was forged as its own narrow skill, but the new
    deploy-coordination umbrella covers it. Demoting to references/.
```

Constraints (enforced by `apply_forge.sh`):

- The forge MUST refuse to prune a skill that has `pinned: true` in its frontmatter.
- The forge MUST refuse to prune a skill whose `origin_hash` no longer matches its current body (human-edited). Even when `origin: memory-forge`, a human edit makes the file off-limits.
- The forge MUST NOT prune a non-forged skill (`origin != memory-forge`). It can only prune its own past output.

## Optional top-level fields

These may appear above the three arrays for context:

```yaml
ran_at: 2026-05-23T14:02:00
lessons_considered: 47          # how many qualifying lessons entered the cluster step
clusters_formed: 6              # how many clusters emerged
clusters_acted_on: 3            # how many produced a consolidation / new_skill / pruning
skipped_by_pre_filter: 12       # how many lessons were <7 days old and skipped
```

These are diagnostic — they're echoed by `apply_forge.sh` into the run log so multiple passes' health can be compared over time.

## Dry-run

Pass `--dry-run` to `apply_forge.sh`. It parses the structured summary and prints what it would do, without writing anything. Useful in CI and for the on-PR-open workflow.

## Rollback

`apply_forge.sh` writes a journal under `project-memory/.forge-journal/<timestamp>.log` for every applied summary. To roll back the most recent run, invoke `apply_forge.sh --rollback <timestamp>`.
