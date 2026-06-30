---
target: cli
layer: 0
covers: [SIBYL-008] # Layer-0 acceptance criteria proven by the SIBYL-008 capstone (committed README + ≥1 decision + live progress / no raw commands)
---

# Journey 00 — Walking skeleton (Originate)

**Story:** As a solo AEP builder, I start SIBYL in an empty directory and the harness guides me through a
modal-form imagine pass, writes a README, commits it to a new git repo, and records the decision — so the
engine↔renderer walking skeleton is proven before any module goes deep, and I never type a raw Pi/git
command.

**Covers:** Layer 0 (walking skeleton) — the single end-to-end Originate journey (SIBYL-008) from the
Layer-0 MVP contract.

**Target:** `cli` — the `sibyl` harness bin (`apps/harness/src/cli.ts`), driven by **bash**. No dev server,
no URL. The harness is an interactive TUI, so the journey drives its **non-interactive/scripted entry**
(seeded form values + auto-confirmed commit) — the engine drives a scripted Pi `AgentSession` (real
`AgentSessionEvent` shapes, **no live model**), so the run is deterministic. The harness runs TypeScript
natively under Bun, so `<harness-bin>` is simply `bun apps/harness/src/cli.ts` (run from the repo root).

**Preconditions:** dependencies installed (`bun install` at the repo root); the harness type-checks under
Node 22.19 (`bun run --cwd apps/harness build`); a fresh empty working directory (a `mktemp -d`); `git`
available with a usable identity (the harness sets a default `GIT_*` identity if none is configured).
`scripts/seed.sh` is a no-op for a `cli` project.

> `<harness-bin>` ⇒ **`bun apps/harness/src/cli.ts`** (run from the repo root).

## Scenario 00.1 — The harness runs

- **Given** the harness dependencies are installed
- **When** `$ bun apps/harness/src/cli.ts --version` runs
- **Then** it exits 0 and prints the SIBYL harness version
- **Verify (bash):** exit code `0`; stdout matches the version string `sibyl 0.0.0`.

## Scenario 00.2 — Originate from an empty dir produces a committed README + a decision

- **Given** an empty temp dir `DIR="$(mktemp -d)"` with no `.git`
- **When** the harness drives the Originate flow non-interactively in `DIR` — seeded form values for the
  imagine pass and an auto-confirmed commit decision:

  ```bash
  bun apps/harness/src/cli.ts originate \
    --product "SIBYL" \
    --problem "no guided originate flow" \
    --vision "a TUI harness that conducts a Pi agent" \
    --yes --cwd "$DIR"
  ```

- **Then** the run completes — no raw Pi/git commands typed — having written and committed a README in a
  new local git repo and persisted at least one decision-memory entry
- **Verify (bash):**
  - exit code `0`;
  - `DIR/README.md` exists and is non-empty;
  - `DIR/.git` exists and `git -C "$DIR" log --oneline` shows ≥1 commit, and
    `git -C "$DIR" show --stat HEAD` lists `README.md`;
  - the decision log records ≥1 `sibyl-decision` entry — the `originate` stdout prints `decisions: 1`, and
    `$ bun apps/harness/src/cli.ts decisions ls --cwd "$DIR"` reads it back (`decisions: 1`,
    `[originate] Commit`) — count ≥ 1;
  - progress was emitted during the run (captured stdout shows `phase:` / `progress:` lines, not a silent
    run).

## Cleanup

No shared fixture — each run uses a throwaway `mktemp -d`; remove it (`rm -rf "$DIR"`). `scripts/seed.sh`
is a no-op for `cli`.
