# Workflow: reconcile-conflicts

When a new lesson contradicts an existing extracted skill — i.e. the project did something that *should* have triggered the forged skill, but the rule was actually wrong, or has since become wrong.

## When this triggers

During [`run-forge.md`](run-forge.md) step 6 (the forge prompt), the scoring rubric flagged a cluster with **counter-evidence**:

> A more recent lesson contradicts the rule encoded in an existing skill, OR a more recent lesson reverses the rule encoded in an older lesson within the cluster.

Don't try to consolidate a cluster with counter-evidence — the structured summary would be wrong. Route here instead.

## Decision: supersede, narrow, or branch

For each conflicting pair (existing-skill-or-lesson) ↔ (new-lesson), pick one of:

### Supersede
The existing rule was wrong (or is now outdated). The new lesson should replace it.

- If the existing rule is **in a forge-origin SKILL.md body** AND that SKILL.md is `untouched` (origin_hash matches): rewrite the SKILL.md body to reflect the new rule. Update `metadata.source_lessons` to include both the original sources and the new contradicting lesson. Re-run `record_origin_hash.sh` after the rewrite.
- If the existing rule is **hand-written** or **human-edited** (origin_hash mismatch): don't touch the SKILL.md. Append a references file marked clearly: `type: superseding-evidence` with the new lesson's content, and ask the user to manually update the SKILL.md body.
- If the existing rule is **in a references file**, not the SKILL.md body: append a new references file marked `type: superseding-evidence`. The original references file stays in place (history is preserved), but the new file documents the reversal.

### Narrow
The existing rule was right in some cases but not all. The new lesson is an exception.

- Append a references file marked `type: scope-narrowing` documenting the exception. Don't rewrite the SKILL.md body. The umbrella stays broad; the references file captures the narrow exception.
- Update the SKILL.md `description:` to reflect the narrowing if the agent should now consider the exception during triggering.

### Branch
The existing rule and the new lesson are both valid, but apply to genuinely different contexts that were previously conflated.

- Split the existing umbrella into two: a new umbrella for the new context, with both umbrellas linked via `metadata.related_skills`. The old umbrella's body may need a clarifying note explaining which context it covers now.
- This is the heaviest option. Use it sparingly — most clusters should resolve as supersede or narrow.

## Steps

### 1. Identify the conflict precisely

For each cluster member with counter-evidence, write down:

- The existing rule (quoted from the SKILL.md or references file).
- The new lesson's contradicting fact (quoted from the lesson file).
- Why the new lesson contradicts (one sentence).

This is required for the rationale field of the resulting structured summary entry — it'll show up in the journal for future passes to understand.

### 2. Pick supersede / narrow / branch

Bias toward **narrow** for ambiguous cases. Superseding throws away the original rule entirely; narrowing keeps both signals. Branching is reserved for cases where the two rules are demonstrably about different things.

### 3. Verify the existing target is editable

For supersede on a forge-origin file:

```bash
bash "$SKILL_DIR/scripts/check_human_edit.sh" "$EXISTING_SKILL_MD"
```

- Exit 0 (untouched) → safe to rewrite the body.
- Exit 1 (human-edited) → body is off-limits. Downgrade the action to a references-only append + a user note.

### 4. Emit the resolution as part of the structured summary

A conflict resolution looks like a `consolidations` entry with a richer `rationale` field:

```yaml
consolidations:
  - target_skill: cache-invalidation
    references_filename: 2026-05-superseding-evidence-async-flush.md
    source_lessons:
      - project-memory/lesson-learned/2026-05-23/session-1402-async-flush.md
    summary: "Async flush invalidates AFTER deploy, reversing the previous 'always sync-flush' rule."
    rationale: |
      Conflicts with the rule in cache-invalidation/references/2026-04-sync-flush-required.md.
      Resolution: supersede. Async flush is now the correct pattern after the v2.4 deploy
      pipeline change. The April lesson is retained in references/ for history; the new
      lesson clarifies the reversal.
```

For superseding rewrites, also emit a `new_skills` entry with the rewritten body (apply_forge.sh handles "replace existing" via the rewrite-and-rehash path — see [`../references/structured-summary-schema.md`](../references/structured-summary-schema.md)).

### 5. Apply and journal

Standard apply path:

```bash
echo "$STRUCTURED_SUMMARY" | bash "$SKILL_DIR/scripts/apply_forge.sh" --dry-run
# review, then:
echo "$STRUCTURED_SUMMARY" | bash "$SKILL_DIR/scripts/apply_forge.sh"
```

The journal entry records both the new references file and (for supersede on the body) the original `origin_hash` so rollback can restore the pre-conflict state.

## What if there's no clean resolution?

Sometimes the conflict reveals that neither lesson is right — the original was wrong, and the new one is wrong differently. In that case:

- Don't consolidate either side.
- Add a comment to **both** lessons' `Open Questions` section pointing to each other.
- Emit no structured-summary entries for this cluster. Note it in the prompt-level analysis above the summary: *"Cluster X has counter-evidence on both sides; no resolution this pass. Both lessons annotated with Open Questions."*

This is one of the legitimate paths to an empty structured summary. The "be ACTIVE" prompt does not require fabricating a resolution where none exists; it requires not staying silent.
