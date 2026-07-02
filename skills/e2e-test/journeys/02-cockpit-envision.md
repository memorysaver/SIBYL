---
target: tui
layer: 1
covers: [SIBYL-013, SIBYL-014, SIBYL-015, SIBYL-017, SIBYL-016] # the envision slice: kernel detect-state routing → compiled brief → typed submit_envision → committed product/index.yaml rendered live on the Architecture tab
---

# Journey 02 — Cockpit: guided envision (a committed README → a committed, schema-valid product framing)

**Story:** As a solo AEP builder whose project already has a **focused, committed `README.md`** (journey 01's
output), I reopen the SIBYL cockpit and it **detects the project's state and boots the ENVISION phase by
itself** — a real agent conducts a product-framing interview on top of my Goal (personas, backbone
activities, release layers, MVP boundary), proposes the framing, and when I approve it completes **only**
through the typed `submit_envision` tool: the **harness** (never the model) writes and commits a
schema-valid `product/index.yaml`, the **Architecture tab re-renders the framing live**, and the completion
is captured as a decision — so my product is **AEP-compatible from birth**, and I never typed a phase name,
a raw command, or a YAML file.

**Covers:** Layer 1 — the envision vertical proven end-to-end through the cockpit:

- **SIBYL-013** (kernel): `detectPhase` routes the cockpit by committed artifacts alone — a committed
  README with no `product/index.yaml` boots the envision session; the phase guard vetoes direct artifact
  writes.
- **SIBYL-014** (typed completion): `submit_envision`'s TypeBox schema is the output contract; the harness
  serializes, writes, and commits `product/index.yaml`.
- **SIBYL-015 + SIBYL-017** (brief): the `sibyl-envision` SKILL.md body is COMPILED into the system prompt
  by the harness — injection, not runtime skill discovery, delivers the flow.
- **SIBYL-016** (this journey's UI): the cockpit surfaces the detected phase (header `[envision]`), the
  Architecture tab renders `product/index.yaml` live (outline of problem / activities / layers), with a
  themed empty state before the submit and a re-render on `artifact_changed` after it — no restart.

Key surface: `sibyl cockpit`; tools the agent uses: read-only discovery (`read`/`grep`/`find`/`ls`) +
`submit_envision`. Complements journey [`01`](01-cockpit-guided-originate.md) (which PRODUCES the committed
README this journey starts from).

> **Why this is the L1 gate.** Envision is the first full instantiation of the ratified Phase Pattern
> (`docs/decisions/sibyl-phase-pattern.md`): registry entry + compiled brief + typed submit, zero new kernel
> machinery. The behavior under test is that the **cockpit routes itself** (detect-state, not a flag), that
> the **model never free-writes the control-plane artifact** (the typed submit is the only path), and that
> the committed framing is **legible in the cockpit** the moment it lands.

**Target:** `tui` — the **interactive cockpit** (`sibyl cockpit`, `apps/harness/src/cli.ts`), driven over a
**pseudo-terminal** by **shell-use** (resolved by [`../tool-selection.md`](../tool-selection.md)). Scenario
02.2 runs against a **LIVE** model — SIBYL's `openai-codex` provider — so read each step as **intent** and
drive adaptively; assert on the **rendered cells** (`shell-use text` / `expect text` / `screenshot`) and on
**git / filesystem effects**.

> **Cost-aware — 02.2 spends real model quota.** Scenario **02.1** (boot-into-envision render smoke) is
> **zero-quota** (the cockpit detects the phase from artifacts alone and connects its `AgentSession`
> *lazily on first input*), so run it first and freely — it is the scenario executed at **this layer's (L1)
> gate**. Scenario **02.2** (the live guided envision) is authored now as the build deliverable but its
> **execution is DEFERRED to the L2 milestone gate** — run it there once, no loops. If the provider isn't
> authed/reachable at that gate, mark 02.2 `SKIP` (not FAIL) with the reason (per `../tool-selection.md`
> degrade).

**Preconditions:**
- Dependencies installed (`bun install` at the repo root); the harness type-checks (`cd apps/harness &&
  bunx tsc --noEmit`).
- `shell-use` healthy: `shell-use --version` (install: `brew tap microsoft/shell-use
  https://github.com/microsoft/shell-use && brew trust microsoft/shell-use && brew install shell-use`).
- For 02.2 only: the model provider is authed — `~/.pi/agent/auth.json` has an `openai-codex` entry; a
  quick liveness check is `bun apps/harness/node_modules/.bin/pi --print --provider openai-codex "say ok"`.
- A fresh working dir pre-initialised as a git repo **with a COMMITTED README and NO `product/index.yaml`**
  (the envision entry condition — journey 01's exit state, seeded directly here):
  ```bash
  DIR="$(mktemp -d)"; git -C "$DIR" init -q
  git -C "$DIR" config user.name "SIBYL Cockpit"; git -C "$DIR" config user.email "cockpit@sibyl.local"
  cat > "$DIR/README.md" <<'MD'
  # Focusflow

  > Make what's next obvious for solo developers.

  ## Problem

  Solo developers lose momentum deciding what to work on next.

  ## Vision

  A tiny tracker that always surfaces exactly one next action.
  MD
  git -C "$DIR" add README.md && git -C "$DIR" commit -q -m "docs: add focused README"
  ```
- `scripts/seed.sh` is a no-op for a `tui` project (throwaway temp dirs, like `cli`).

> **shell-use driver notes** (see the `shell-use-cockpit-dogfood` project memory for the full recipe):
> launch with process cwd == project cwd — `shell-use open --cwd "$DIR" --cols 120 --rows 36` then
> `shell-use submit "<abs-bun> <abs-cli> cockpit --cwd $DIR"`; send chat input with `shell-use submit
> "<text>"` (types + Enter). **`wait idle` is NOT a reliable turn-complete signal** while the agent shows
> `● thinking` — instead **poll the real outcome** (`git -C "$DIR" log` / `test -f "$DIR/product/index.yaml"`)
> with `shell-use wait idle --timeout 20000` as the sleep-free delay between checks. Switch tabs by sending
> `press Tab` **one at a time** (a batched `Tab Tab Tab` coalesces). `expect text` reporting "strict
> violation: N elements" still means the text is present.

## Scenario 02.1 — The cockpit detects the state and boots INTO envision (zero-quota render smoke)

Runs at the **L1 gate**.

- **Given** the seeded repo `DIR` above: `README.md` **committed** at `HEAD`, **no** `product/index.yaml`
- **When** `sibyl cockpit --cwd "$DIR"` is launched in a PTY via shell-use, and the screen settles
  (`shell-use wait idle`) — **no chat input is sent**, so no prompt/model call is ever made
- **Then** the fixed cockpit renders **already in the envision phase**: the header shows the phase
  indicator `[envision]` (detect-state routing — the user typed no phase name), the **4-tab bar**
  (Goal · Story Map · Architecture · Decisions) with **Goal active** rendering the committed README
  WYSIWYG, the chat panel with a `>` input, and the footer key hints; and the **Architecture tab shows its
  empty state** ("No product/index.yaml yet …") because envision has not completed
- **Verify (shell-use, zero quota):**
  - `expect text "[envision]"` — the phase indicator is rendered in the header (boot routed by artifacts,
    not by a flag);
  - `expect text "Goal"`, `"Story Map"`, `"Architecture"`, `"Decisions"` all present; the chat `>` prompt
    is visible; the Goal body shows the seeded README's heading (e.g. `Focusflow`);
  - `press Tab` twice (one at a time) to reach **Architecture**: `expect text "No product/index.yaml yet"`
    — the themed empty state, not a crash and not stale content;
  - the run sent **no** chat input → spends **no** model budget.

## Scenario 02.2 — Guided envision: interview → typed submit → committed framing on the Architecture tab (LIVE model — execution deferred to the L2 gate)

- **Given** the cockpit is running in `DIR` (02.1's end state: envision booted, Architecture empty), and
  the builder's README is intentionally **vague-ish** about product shape (it names a problem and a vision
  but no personas, activities, layers, or MVP boundary)
- **When** the builder opens with an under-specified framing request — e.g.
  `submit: "Frame this product for me — I know the goal but not the shape."`
- **Then** the envision conductor **interviews, one focused question at a time**, anchored on the committed
  README (who exactly is the persona? what does the user DO end-to-end? what's the thinnest shippable
  layer? what's out of scope?) — it does **not** dump a full framing unprompted, and it does **not** write
  any file (its tools are read-only + `submit_envision`; the phase guard vetoes free writes)
- **Verify (shell-use):** **before** `product/index.yaml` exists (`test -f` is false), the chat transcript
  shows **≥1 assistant turn asking a framing question** (a line ending in `?` about personas / activities /
  layers / scope). `git -C "$DIR" log --oneline` still shows only the README commit.

- **When** the builder answers the questions (e.g. persona `solo developers`, backbone
  `capture → prioritize → focus`, L0 `see one next action`, out of scope `teams/multiplayer`) and the agent
  **proposes the framing** for approval
- **Then** the proposal reflects the builder's answers (their distinctive terms appear), and the agent asks
  for approval **before** submitting
- **When** the builder approves — e.g. `submit: "yes — submit that framing."`
- **Then** the agent calls **`submit_envision`** (visible as tool activity in the chat panel); the
  **harness** validates the payload (schema + semantic rules), writes `product/index.yaml`, and
  **git-commits it itself**; the **Architecture tab re-renders live** with the framing outline; the
  completion is **captured as a decision** and surfaced on the Decisions tab — all with **no restart** and
  **no raw command typed**
- **Verify:**
  - **Typed-submit only (the point of the phase pattern):** the chat shows `✓ submit_envision` tool
    activity; there is **no** `write`/`edit` tool activity targeting `product/index.yaml` (the model never
    free-writes the control-plane artifact).
  - **STRUCTURAL (the framing artifact):** `product/index.yaml` **parses as YAML** (e.g.
    `bun -e 'const{parse}=await import("yaml");parse(await Bun.file(process.argv[1]).text())' "$DIR/product/index.yaml"`)
    and the parsed document has:
    - `product.activities` — a non-empty array where **every** activity has an `order` (integer ≥ 1) **and**
      a `layer_introduced`;
    - `product.layers` — a non-empty array where **every** layer has a `user_can`;
    - plus `product.problem` (non-empty string) and top-level `personas` (≥ 1).
  - **Committed by the harness:** `git -C "$DIR" log --oneline` shows a **new commit** whose subject is the
    harness's envision commit (`feat(envision): commit product/index.yaml (product framing)`), and
    `git -C "$DIR" show --stat HEAD` lists `product/index.yaml`.
  - **Architecture tab re-rendered (SIBYL-016 AC2):** `press Tab` to **Architecture**; it now renders the
    framing outline — `expect text "Product framing"`, `"Activities"`, `"Layers"`, and at least one
    `L0`/`L1` layer line with its `user can:` text; the "No product/index.yaml yet" empty state is gone.
  - **Decision captured + surfaced:** `press Tab` to **Decisions**; it renders the envision completion
    entry (`[envision] Committed product/index.yaml (envision framing)`); the chat also shows the submit
    confirmation.
  - **Focus reflected:** the framing encodes the builder's interview answers — e.g.
    `grep -iqE 'solo|next action' "$DIR/product/index.yaml"`.

## Cleanup

`shell-use press Ctrl+C` then `shell-use close --all`; `rm -rf "$DIR"`. **Cost-aware:** 02.1 is free — run
it at the L1 gate; run at most one `02.2` conversation, **at the L2 milestone gate**, no loops. Record
evidence with the unified report format (`../tool-selection.md` → "Unified report") into
`.dev-workflow/dogfood-cockpit-envision.md` — the rendered `shell-use text` of the header + Architecture +
Decisions tabs, a `screenshot -o` capture, and the `git -C "$DIR" log` / `show --stat HEAD` output.
