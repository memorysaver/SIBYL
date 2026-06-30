# Workflow: run-forge

The main consolidation pass. Run this when the user explicitly asks to forge a skill, distill lessons, or consolidate project-memory.

## Trigger phrases

- "forge a skill from these lessons"
- "distill lessons"
- "extract skills from memory"
- "consolidate project-memory"
- "turn lessons into skills"
- "memory curator"
- "evolve our skills"

## Pre-flight

Resolve `$SKILL_DIR` to wherever this skill is installed. From here, every script invocation uses that absolute path.

```bash
# In Claude Code, the discovery symlink is .claude/skills/memory-forge.
# Resolve it once at the start of the pass.
SKILL_DIR="$(cd "$(readlink .claude/skills/memory-forge 2>/dev/null || echo .claude/skills/memory-forge)" && pwd -P)"
```

If `project-memory/` doesn't exist, abort with a clear message: *"No project-memory/ found. Run the project-memory `bootstrap-memory` workflow first to create one, then come back."*

## Steps

### 1. Detect output target

```bash
bash "$SKILL_DIR/scripts/detect_target.sh" --explain
```

Capture the result. The script prints `<rule>\t<absolute-target-dir>`. Show the user which rule fired and where the forge will write. If the user objects, accept `MEMORY_FORGE_TARGET=<absolute-path>` as an override and re-run detection.

### 2. Select eligible lessons (age pre-filter)

```bash
bash "$SKILL_DIR/scripts/select_lessons.sh" --since-last-forge
```

This returns lesson paths that are ≥7 days old AND newer than the last forge run. If empty:

- If the most recent journal entry is <24 hours old → say *"Already forged today; nothing new under the 7-day pre-filter."* and stop.
- Otherwise → say *"All N candidate lessons are <7 days old (still settling). Re-run after the pre-filter window."* Don't proceed.

This is the "honest no-op" path. The pass must explain why it did nothing — silent no-op is the failure mode the skill is designed to fight.

### 3. Cluster

```bash
bash "$SKILL_DIR/scripts/select_lessons.sh" --since-last-forge \
  | bash "$SKILL_DIR/scripts/cluster_lessons.sh" --min-cluster-size 2
```

The clusters are emitted as `## cluster` blocks. Each cluster has a `theme`, `members`, and `shared_tags`. Read each cluster — the members are the lesson files to consolidate.

If zero clusters of size ≥2 emerge:

- Say *"N qualifying lessons but no recurring theme yet (every lesson is unique). Re-run after more sessions accumulate."* Stop.
- Don't force a one-off skill from a singleton lesson. That's the "flat list = failure" failure mode.

### 4. Load extraction prompts

Read [`../references/extraction-prompts.md`](../references/extraction-prompts.md). It contains the two opposing-pressure prompts that drive this pass:

- **Prompt A — capture pressure** ("be ACTIVE")
- **Prompt B — umbrella pressure** ("flat list = failure")

Use both in the order documented there. They are load-bearing — quote them verbatim into your reasoning, don't paraphrase.

### 5. Read existing skills at the target

Before proposing consolidations or new umbrellas, list what already exists at the detected target:

```bash
ls -1 "$(bash "$SKILL_DIR/scripts/detect_target.sh" | cut -f2)" 2>/dev/null || true
```

Then for each existing skill, read its `SKILL.md` frontmatter — note the `description` (the trigger phrase set) and `metadata.origin` (forge-origin vs hand-written). This tells you which umbrellas can absorb new lessons, and which skills are off-limits because they're hand-written.

### 6. Run the forge prompt

For each cluster, decide one of:

- **Consolidation** — append to an existing umbrella's `references/`. Pick this if an existing umbrella (forge-origin OR hand-written — both are valid merge targets) clearly covers the cluster's theme.
- **New umbrella** — create a class-level skill. Pick this if no existing umbrella covers the theme and ≥2 lessons share it. The new SKILL.md must be class-level (general enough to absorb future related lessons), not narrow.
- **Pruning** — demote a narrow forge-origin skill into a broader umbrella's `references/`. Pick this if you created a narrow skill in a prior pass and a new broader umbrella now subsumes it. Pruning a hand-written or pinned skill is forbidden — `apply_forge.sh` will refuse it.

Apply the scoring rubric from [`../references/extraction-prompts.md`](../references/extraction-prompts.md) to each cluster before deciding.

### 7. Emit the structured summary

Produce a `## Structured summary` block following [`../references/structured-summary-schema.md`](../references/structured-summary-schema.md). Include the diagnostic fields (`lessons_considered`, `clusters_formed`, etc.) so future passes have comparable health metrics.

If after Steps 5–6 the structured summary is empty (no consolidations, no new_skills, no prunings), include an explicit explanation above it naming which step produced the empty result. Example: *"3 clusters formed, but each one is dominated by counter-evidence in a more recent lesson. Routed to reconcile-conflicts.md."*

### 8. Dry-run, then apply

Always dry-run first:

```bash
echo "$STRUCTURED_SUMMARY" | bash "$SKILL_DIR/scripts/apply_forge.sh" --dry-run
```

Show the user what would change. If they confirm:

```bash
echo "$STRUCTURED_SUMMARY" | bash "$SKILL_DIR/scripts/apply_forge.sh"
```

`apply_forge.sh` writes a journal entry to `project-memory/.forge-journal/<UTC-stamp>.log` describing every action. To roll back the most recent run:

```bash
bash "$SKILL_DIR/scripts/apply_forge.sh" --rollback <UTC-stamp>
```

### 9. Regenerate discovery symlinks (canonical layout only)

If `detect_target.sh` returned rule 1 (canonical layout) and a project-side `scripts/link-skills.sh` exists, run it:

```bash
if [ -x scripts/link-skills.sh ]; then bash scripts/link-skills.sh; fi
```

If no such script exists but the layout is canonical, the forge can write the per-skill symlinks itself as a one-time fix-up. See [`../references/target-detection.md`](../references/target-detection.md).

For rules 2–5, no symlink work is needed.

### 10. Verify origin hashes

For each new SKILL.md the forge wrote, confirm the hash is recorded correctly:

```bash
for skill in $(find "$TARGET_DIR" -name SKILL.md -newer "$JOURNAL_FILE" 2>/dev/null); do
  bash "$SKILL_DIR/scripts/check_human_edit.sh" "$skill"
done
```

Every newly-forged skill should report `untouched`. If any reports `human-edited`, that's a bug in `apply_forge.sh` — flag it to the user; don't ignore.

### 11. Refresh the project-memory qmd index

Project-memory's `qmd_update.sh` is idempotent. Run it so the new forge journal and any references files become searchable:

```bash
if [ -x project-memory/_CONTEXT.md ] || [ -f project-memory/_CONTEXT.md ]; then
  if PROJECT_MEMORY_SKILL="$(readlink .claude/skills/project-memory 2>/dev/null)"; then
    bash ".claude/skills/project-memory/scripts/qmd_update.sh" || true
  fi
fi
```

Safe no-op if qmd isn't installed.

### 12. Report back

Print, concisely:

- The number of lessons considered, clusters formed, and actions applied.
- The paths of newly-created or modified skills (one per line).
- The journal file path (for rollback).
- A reminder to `git add` and commit: *"git add skills/ .claude/skills/ project-memory/.forge-journal/ && git commit -m 'forge: distill <N> lessons'"*

## Don't

- Don't propose consolidations into a skill that doesn't exist at the target — `apply_forge.sh` will skip it and you'll have done LLM work for nothing. Always read the target first.
- Don't try to be clever about pinning. The user pins skills manually. The forge respects `pinned: true` and never sets it back to `false`.
- Don't run the forge during an in-progress session. Forge passes are end-of-mission work. If a session is ongoing, capture the lesson via `project-memory` first; the forge will pick it up after the pre-filter window.
