---
target: cli
layer: 0
covers: [] # Layer-0 acceptance-criterion ids once the gate matrix is written (feeds gate coverage); see SIBYL-008
---

# Journey 00 — Walking skeleton (Originate)

**Story:** As a solo AEP builder, I start SIBYL in an empty directory and the harness guides me through a
modal-form imagine pass, writes a README, commits it to a new git repo, and records the decision — so the
engine↔renderer walking skeleton is proven before any module goes deep, and I never type a raw Pi/git
command.

**Covers:** Layer 0 (walking skeleton) — the single end-to-end Originate journey (SIBYL-008) from the
Layer-0 MVP contract.

**Target:** `cli` — the built harness binary (`apps/harness`), driven by **bash**. No dev server, no URL.
The harness is an interactive TUI, so the journey drives its **headless/scripted entry** (seeded form
values + auto-confirm) — the same path the renderer-agnostic seam smoke test (SIBYL-002) uses — so the run
is deterministic. _(Replace `<harness-bin>` / flags below with the real invocation once SIBYL-001..008
land.)_

**Preconditions:** harness built under Node 22.19 (`<build-cmd>`, e.g. `bun run --cwd apps/harness build`);
a fresh empty working directory (a `mktemp -d`); `git` available. `scripts/seed.sh` is a no-op for a `cli`
project.

> This journey ships as a **seed** — fill the `<…>` placeholders with the real Layer-0 invocation for
> SIBYL. One green end-to-end run is the goal; don't chase coverage here.

## Scenario 00.1 — The harness runs
- **Given** the harness is built
- **When** `$ <harness-bin> --version` runs
- **Then** it exits 0 and prints the SIBYL harness version
- **Verify (bash):** exit code `0`; stdout matches the version string (e.g. `sibyl <semver>`).

## Scenario 00.2 — Originate from an empty dir produces a committed README + a decision
- **Given** an empty temp dir `DIR="$(mktemp -d)"` with no `.git`
- **When** the harness drives the Originate flow non-interactively in `DIR` — seeded form values for the
  imagine pass and an auto-confirmed commit decision, e.g.
  `$ (cd "$DIR" && <harness-bin> originate --product "<p>" --problem "<q>" --vision "<v>" --yes)`
- **Then** the run completes — no raw Pi/git commands typed — having written and committed a README in a
  new local git repo and persisted at least one decision-memory entry
- **Verify (bash):**
  - exit code `0`;
  - `DIR/README.md` exists and is non-empty;
  - `DIR/.git` exists and `git -C "$DIR" log --oneline` shows ≥1 commit, and
    `git -C "$DIR" show --stat HEAD` lists `README.md`;
  - the decision log records ≥1 `sibyl-decision` entry (read it via the harness, e.g.
    `<harness-bin> decisions ls` / a session-entries readout) — count ≥ 1;
  - progress was emitted during the run (captured stdout shows phase/progress lines, not a silent run).

## Cleanup
No shared fixture — each run uses a throwaway `mktemp -d`; remove it (`rm -rf "$DIR"`). `scripts/seed.sh`
is a no-op for `cli`.
