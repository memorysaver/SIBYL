---
target: tui
layer: 0
covers: [SIBYL-009, SIBYL-010, SIBYL-011] # the cockpit: guided conversation → committed README (Goal, live) + captured commit decision (Decisions)
---

# Journey 01 — Cockpit: guided originate (a half-formed idea → a focused, committed README)

**Story:** As a solo AEP builder who arrives with only a *half-formed* product idea, I open the SIBYL
cockpit and a real agent **conducts a focused question-and-answer dialogue** that sharpens my idea into a
clear goal — it asks one focused question at a time, refines `README.md` live in the Goal tab as it learns,
and when I approve, commits it itself and records the decision — so I reach a **committed, focused product
goal through guided conversation**, never a form and never a raw command.

**Covers:** Layer 0 — the *cockpit* half of the walking skeleton (the re-sliced L0): the guided
conversation (`COCKPIT_GUIDE`), the live Goal-tab WYSIWYG (SIBYL-010), and the agent-commit → decision
capture surfaced in the Decisions tab (SIBYL-011). Complements the deterministic headless path in
[`00-walking-skeleton.md`](00-walking-skeleton.md) (which proves the same write→commit→decision *machinery*
with a scripted model). Key surface: `sibyl cockpit`; tools the agent uses: `write`, `git`.

**Target:** `tui` — the **interactive cockpit** (`sibyl cockpit`, `apps/harness/src/cli.ts`), driven over a
**pseudo-terminal** by **shell-use** (resolved by [`../tool-selection.md`](../tool-selection.md)). The
conversation runs against a **LIVE** model — SIBYL's `openai-codex` provider (the user's ChatGPT-subscription
OAuth; default `gpt-5.3-codex-spark`) — so it is **non-deterministic**: read each step as **intent** and
drive adaptively (the openers/answers below are examples — vary the wording, preserve the intent). Assert on
the **rendered cells** (`shell-use text` / `expect text` / `screenshot`) and on **git / filesystem effects**.

> **Cost-aware — this journey spends real model quota.** Scenario **01.1** (render/framework) is a
> **zero-quota** smoke (the cockpit connects its `AgentSession` *lazily on first input*), so run it first
> and freely. Scenario **01.2** (the guided conversation) is the part that costs budget — keep it to a few
> turns and run **no loops**. If the provider isn't authed/reachable, run 01.1 and mark 01.2 `SKIP` (not
> FAIL) with the reason (per `../tool-selection.md` degrade).

**Preconditions:**
- Dependencies installed (`bun install` at the repo root); the harness type-checks (`cd apps/harness &&
  bunx tsc --noEmit`).
- `shell-use` healthy: `shell-use --version` (install: `brew tap microsoft/shell-use
  https://github.com/microsoft/shell-use && brew trust microsoft/shell-use && brew install shell-use`).
- For 01.2 only: the model provider is authed — `~/.pi/agent/auth.json` has an `openai-codex` entry; a
  quick liveness check is `bun apps/harness/node_modules/.bin/pi --print --provider openai-codex "say ok"`.
- A fresh working dir pre-initialised as a git repo with a usable identity so the agent's commit can't fail
  on setup:
  ```bash
  DIR="$(mktemp -d)"; git -C "$DIR" init -q
  git -C "$DIR" config user.name "SIBYL Cockpit"; git -C "$DIR" config user.email "cockpit@sibyl.local"
  ```
- `scripts/seed.sh` is a no-op for a `tui` project (throwaway temp dirs, like `cli`).

> **shell-use driver notes** (see the `shell-use-cockpit-dogfood` project memory for the full recipe):
> launch with process cwd == project cwd — `shell-use open --cwd "$DIR" --cols 120 --rows 40` then
> `shell-use submit "<abs-bun> <abs-cli> cockpit --cwd $DIR"`; send chat input with `shell-use submit
> "<text>"` (types + Enter). **`wait idle` is NOT a reliable turn-complete signal** while the agent shows
> `● thinking` — instead **poll the real outcome** (`git -C "$DIR" log`) with `shell-use wait idle
> --timeout 20000` as the sleep-free delay between checks. Switch tabs by sending `press Tab` **one at a
> time** (a batched `Tab Tab Tab` coalesces). `expect text` reporting "strict violation: N elements" still
> means the text is present.

## Scenario 01.1 — The cockpit boots and lays out (zero-quota render smoke)

- **Given** a fresh working dir `DIR` (may hold a seed `README.md` or none)
- **When** `sibyl cockpit --cwd "$DIR"` is launched in a PTY via shell-use, and the screen settles
  (`shell-use wait idle`) — **no chat input is sent**, so no model is called
- **Then** the fixed cockpit renders: the header, the **4-tab bar** (Goal · Story Map · Architecture ·
  Decisions) with **Goal active**, the primary panel (Goal renders `README.md` WYSIWYG, or a "No README
  yet" empty-state when the dir is empty), the **chat** panel with a `>` input, and the footer key hints;
  and pressing `Tab` cycles the active tab
- **Verify (shell-use, zero quota):** `expect text "Goal"`, `"Story Map"`, `"Architecture"`,
  `"Decisions"` all present; the chat `>` prompt is visible; after one `press Tab` the active-tab marker
  (`‹ … ›`) moves off Goal; a seeded README's heading renders in the Goal body when present. Spends **no**
  model budget.

## Scenario 01.2 — Guided focus: a vague idea becomes a focused, committed README (LIVE model)

- **Given** the cockpit is running (01.1) in the empty git repo `DIR`, and the builder has only a **vague,
  unfocused** idea
- **When** the builder opens with a deliberately **under-specified** goal — e.g.
  `submit: "I want to build some kind of tool to help developers, but I haven't figured out what exactly —
  help me focus it."`
- **Then** the agent **conducts a focusing dialogue**: it asks a **focused clarifying question, one at a
  time** (who is it for? / what's the core problem? / the single outcome?) — it does **not** immediately
  dump a full README or present a form
- **Verify (shell-use):** **before any commit exists** (`git -C "$DIR" log` is still empty), the chat
  transcript shows **≥1 assistant turn that asks a focusing question** — an assistant line ending in `?`
  that narrows scope (audience / problem / outcome). This is the evidence of *guiding*, not one-shot
  generation.

- **When** the builder answers with a **sharpening** detail — e.g.
  `submit: "solo developers — the pain is never knowing what to work on next."`
- **Then** the agent reflects the sharpened understanding and **writes / refines `README.md`** so the
  **Goal tab** shows the *focused* goal (a title, a one-line pitch, `## Problem`, `## Vision` that track the
  answer), optionally asking one more focusing question before it settles
- **Verify (shell-use):** `press Tab` to the **Goal** tab; it re-renders (on `artifact_changed`) and now
  reflects the **focused** framing — it contains a **distinctive term the builder introduced in their
  answer** (e.g. `solo`, and/or the phrase about *what to work on next*), i.e. the goal got **sharper
  through the dialogue** rather than a generic restatement of the vague opener.

- **When** the builder approves committing — e.g. `submit: "that's it — commit it."`
- **Then** the agent **commits `README.md` itself** via its `git` tool; the harness **captures the commit
  as a decision**; the **Decisions tab** and a chat confirmation reflect it; the builder typed **no raw
  git/Pi command**
- **Verify:**
  - **Guided (the point of this journey):** ≥1 focused question preceded the committed README (from the
    step above) — the idea was **focused through Q&A**, not produced in one shot.
  - **Focus reflected:** the committed `DIR/README.md` contains a distinctive term the builder introduced
    while answering — e.g. `grep -iqE 'solo|what to work on next' "$DIR/README.md"` — so the artifact
    encodes the *sharpened* goal, not just the vague opener.
  - **Structural (README shape):** `grep -qE '^# .+'` (a level-1 title) **and** a non-empty one-line pitch
    beneath it **and** `grep -qE '^## Problem'` with a non-empty body **and** `grep -qE '^## Vision'` with
    a non-empty body, and the file is non-trivial (`wc -c < "$DIR/README.md"` ≥ 200).
  - **Committed:** `git -C "$DIR" log --oneline` shows ≥1 commit and `git -C "$DIR" show --stat HEAD` lists
    `README.md` (the commit lands in `DIR`, the run cwd).
  - **Decision captured + surfaced:** `press Tab` to the **Decisions** tab; it renders the captured entry
    (`[originate] Committed README.md …`), replacing the "(coming soon)" placeholder — recalled from the
    run's in-memory `SessionManager` (no `.sibyl` mirror is required for the `tui` path; the tab render *is*
    the recall). The chat also shows the commit confirmation (`Commit: <sha>`).
  - **Progress/streaming (not a silent run):** the chat panel showed live tool activity during the turn
    (e.g. `✓ write README.md`, `✓ git add`, `✓ git commit`) and an assistant confirmation.

## Cleanup

`shell-use press Ctrl+C` then `shell-use close --all`; `rm -rf "$DIR"`. **Cost-aware:** run at most one
`01.2` conversation per gate; **no loops**. Record evidence with the unified report format
(`../tool-selection.md` → "Unified report") into `.dev-workflow/dogfood-cockpit.md` — the rendered
`shell-use text` of the Goal + Decisions tabs, a `screenshot -o` SVG, and the `git -C "$DIR" log` /
`show --stat HEAD` output.
