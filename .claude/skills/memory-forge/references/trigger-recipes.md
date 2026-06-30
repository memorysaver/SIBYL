# Trigger recipes

Copy-paste snippets for integrating `memory-forge` into common automation surfaces.

## Pre-PR hook (manual `gh` flow)

If your agent or scripts call `gh pr create` directly, wrap it so a forge pass runs first:

```bash
# scripts/open-pr.sh
#!/usr/bin/env bash
set -euo pipefail

# Run the forge in non-interactive dry-run first to see if anything is pending.
NEW_LESSONS=$(bash "$SKILL_DIR/scripts/select_lessons.sh" --since-last-forge --count)

if [ "${NEW_LESSONS:-0}" -ge 3 ]; then
  echo "memory-forge: $NEW_LESSONS new lessons accumulated since last forge — running pass."
  bash "$SKILL_DIR/scripts/select_lessons.sh" --since-last-forge \
    | bash "$SKILL_DIR/scripts/cluster_lessons.sh" \
    | <invoke-the-agent-here-to-produce-structured-summary> \
    | bash "$SKILL_DIR/scripts/apply_forge.sh"

  # Stage any newly-forged skills onto the same branch.
  git add skills/ .claude/skills/ .agents/skills/ .codex/skills/ 2>/dev/null || true
  git diff --cached --quiet || git commit -m "forge: distill $NEW_LESSONS recent lessons"
fi

gh pr create "$@"
```

The `<invoke-the-agent-here>` step is where the LLM forge pass runs. In Claude Code, the agent typically invokes this skill directly and produces the structured summary itself.

## GitHub Actions — comment forge proposal on PR open

If you want every PR to surface what the forge *would* do without auto-applying:

```yaml
# .github/workflows/memory-forge.yml
name: memory-forge proposal

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  propose:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Run forge in dry-run
        id: forge
        env:
          SKILL_DIR: ${{ github.workspace }}/.claude/skills/memory-forge
        run: |
          NEW_LESSONS=$(bash "$SKILL_DIR/scripts/select_lessons.sh" --since-last-forge --count)
          echo "new_lessons=$NEW_LESSONS" >> "$GITHUB_OUTPUT"
          if [ "$NEW_LESSONS" -ge 3 ]; then
            # The actual LLM call happens here — wired to whichever Claude Code / Codex
            # CLI runner is set up for the repo. The output should be a structured
            # summary block.
            <your-agent-cli> --skill memory-forge --dry-run > forge-proposal.md
          fi

      - name: Comment on PR
        if: steps.forge.outputs.new_lessons >= 3
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            if (!fs.existsSync('forge-proposal.md')) return;
            const body = `## memory-forge proposal\n\n` +
                         fs.readFileSync('forge-proposal.md', 'utf-8');
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              body
            });
```

This stays advisory — the PR comment shows the structured summary, and the human decides whether to apply it (by merging the proposal commit or running the forge locally).

## Cron / scheduled forge

If your project accumulates lessons faster than humans review them, run a periodic forge pass:

```yaml
# .github/workflows/memory-forge-weekly.yml
name: memory-forge weekly

on:
  schedule:
    - cron: '0 14 * * MON'  # Mondays 14:00 UTC
  workflow_dispatch:

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run forge pass
        run: |
          <your-agent-cli> --skill memory-forge --apply
      - name: Open PR with forged skills
        run: |
          git checkout -b "memory-forge/$(date +%Y-%m-%d)"
          git add skills/ .claude/skills/ .agents/skills/ .codex/skills/ 2>/dev/null || true
          if ! git diff --cached --quiet; then
            git commit -m "forge: weekly distillation"
            git push -u origin HEAD
            gh pr create --title "memory-forge weekly" --body "Automated forge pass"
          fi
```

## Project-memory wrap-up integration

When `project-memory`'s `wrap-up-session.md` runs, it includes a suggestion step to invoke `memory-forge` if enough lessons have accumulated. The wrap-up workflow already has this step appended (see [../../project-memory/workflows/wrap-up-session.md](../../project-memory/workflows/wrap-up-session.md), step 7).

You don't need to wire this up yourself — installing both skills makes the integration automatic.

## Manual invocation

Just type one of the trigger phrases:

- "forge a skill from these lessons"
- "distill the lessons"
- "consolidate project-memory"
- "extract skills from memory"
- "evolve our skills"

The agent will load `memory-forge`'s `workflows/run-forge.md` and run the full pass.
