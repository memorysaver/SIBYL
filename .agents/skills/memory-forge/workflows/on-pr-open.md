# Workflow: on-pr-open

Run a forge pass before opening a pull request, so any new lessons get distilled into the same commit that introduces the underlying changes.

## When this triggers

The agent is about to call `gh pr create` (or equivalent: `git push` followed by a PR creation step). Concretely:

- The user said: "open the PR", "create a PR", "push and open a PR", "submit the PR".
- The agent has been working on a feature branch and has finished implementation + verification.

Don't trigger this on every push to a non-PR branch. The point is to bundle the forge with the PR, not with arbitrary pushes.

## Steps

### 1. Decide if the forge should run

```bash
NEW="$(bash "$SKILL_DIR/scripts/select_lessons.sh" --since-last-forge --count)"
ELIGIBLE="$(bash "$SKILL_DIR/scripts/select_lessons.sh" --since-last-forge | wc -l | tr -d ' ')"
```

- `ELIGIBLE == 0` → no forge pass. Proceed to step 5 (open the PR normally).
- `ELIGIBLE >= 1` → continue with the forge pass.

### 2. Tell the user what's about to happen

> $ELIGIBLE eligible lessons have accumulated since the last forge. I'll run the forge pass first and include any extracted skills in the same commit as the PR. Continue?

Wait for confirmation. If the user declines, skip to step 5.

### 3. Run the forge

Load [`run-forge.md`](run-forge.md) and run it through step 8 (dry-run → apply). Step 9 (symlinks) is required here too if the layout is canonical.

### 4. Commit the forged skills

```bash
git add skills/ .claude/skills/ .agents/skills/ .codex/skills/ project-memory/.forge-journal/ 2>/dev/null || true
if ! git diff --cached --quiet; then
  N_NEW=$(grep -c '^CREATE_SKILL' "$(ls -t project-memory/.forge-journal/*.log | head -n1)")
  N_REF=$(grep -c '^APPEND_REF' "$(ls -t project-memory/.forge-journal/*.log | head -n1)")
  git commit -m "forge: $N_NEW new skill(s), $N_REF references append(s)"
fi
```

The commit goes on the same branch that's about to become a PR. The PR description should mention the forge bundle:

> Includes a memory-forge pass: N new skill(s), M references append(s) from K source lessons. See `project-memory/.forge-journal/<stamp>.log` for the full action list.

### 5. Open the PR

Continue with the normal `gh pr create` flow. Use whatever PR title/body workflow the user prefers.

### 6. Annotate the PR

After the PR is open, add a comment with the structured summary's diagnostic fields so reviewers can see the forge's "health" at a glance:

```
memory-forge stats:
- lessons_considered: <N>
- clusters_formed: <M>
- clusters_acted_on: <K>
- skipped_by_pre_filter: <P>
```

Use `gh pr comment <number> --body "..."` for this.

## What if the forge pass fails or refuses?

If the structured summary is empty and the forge reports "no recurring theme yet" or "all candidates under pre-filter":

- Skip the commit step. Don't create an empty forge commit.
- Mention in the PR description: *"memory-forge: nothing to consolidate yet ($NEW lessons pending future passes)."*
- Open the PR normally.

If the user previously hand-edited a forged skill and the forge tried to overwrite it but was blocked by `check_human_edit.sh`:

- That's expected behavior, not a failure. The body was preserved; only references/ was touched (if at all).
- No special PR annotation needed — the journal will record `APPEND_REF` lines but no `CREATE_SKILL` overwrites.

## Why this lives in the same commit as the PR

The forge is *about* this PR's work — the lessons it distills came from the sessions that produced this PR. Bundling them keeps the PR self-contained and lets the reviewer see the lesson → skill distillation in context. Splitting them into a separate "forge-only" PR adds review overhead without clarity.

If the project prefers separate "skill update" PRs by policy, see [`../references/trigger-recipes.md`](../references/trigger-recipes.md) — there's a CI recipe for that flow.
