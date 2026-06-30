# Workflow: on-wrap-up

This workflow runs as a lightweight proactive check after `project-memory`'s `wrap-up-session.md` has finished writing a new lesson file. It does not run the full forge pass — it only decides whether to suggest one to the user.

## When this triggers

`project-memory/workflows/wrap-up-session.md` has an additive step at the end: *"if memory-forge is available and ≥3 new lessons accumulated since the last forge, suggest running it."* That step loads this workflow.

You should also load this workflow if the user just finished writing a `project-memory/lesson-learned/` entry (manually or via `project-memory`'s `capture-moment.md`) and you, as the agent, judge that a wrap-up moment has just happened.

## Steps

### 1. Count new lessons since the last forge

```bash
NEW="$(bash "$SKILL_DIR/scripts/select_lessons.sh" --since-last-forge --count)"
```

- `NEW < 3` → say nothing. Don't suggest the forge — there isn't enough new signal.
- `NEW >= 3` → continue.

### 2. Check the pre-filter

If all `NEW` lessons are <7 days old, the forge pass would do nothing. Check:

```bash
ELIGIBLE="$(bash "$SKILL_DIR/scripts/select_lessons.sh" --since-last-forge | wc -l | tr -d ' ')"
```

- `ELIGIBLE == 0` → say *"$NEW new lessons accumulated since last forge, but all are <7 days old. The forge pass would no-op until the oldest hits the 7-day window."* Don't suggest running it.
- `ELIGIBLE >= 1` → continue.

### 3. Suggest the pass

Print to the user, concisely:

> $NEW new lessons have accumulated since the last forge ($ELIGIBLE past the 7-day pre-filter). Want me to run a forge pass to distill them into reusable skills? It'll dry-run first so you can review.

Wait for explicit confirmation. **Never run the pass automatically.** This skill is invoke-driven by design.

### 4. If confirmed, hand off

Load [`run-forge.md`](run-forge.md) and execute the full pass from step 1.

### 5. If declined

Make a note in the most recent lesson file's `Takeaways` section: *"Skipped forge pass at wrap-up; $NEW lessons pending."* This way the next wrap-up will know how many lessons are queued without needing to recount.

## Why this is a separate workflow

The main `run-forge.md` is heavy — it loads the extraction prompts, reads existing skills, runs an LLM pass, dry-runs, applies, and refreshes indexes. Triggering all of that automatically at every wrap-up would be noisy.

`on-wrap-up.md` is the cheap gate. It does only the counting + filter logic, then either suggests or stays silent. The full pass only runs on the user's explicit OK.
