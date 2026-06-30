# SIBYL-003 — Drive imagine→README task through Pi + map progress events

## What

Implement `apps/harness/src/engine/originate.ts` as the real `EngineRunCore`
(SIBYL-002 injection point) that plugs into `createEngine(core)` and conducts a
Pi agent through a guided **imagine → README** pass. No change to `seam.ts` /
`state-machine.ts`.

- `startForm` (idle → form) requests the originate form
  (`product` / `problem` / `vision`).
- `runToDecision` (form → running → decision): opens a Pi `AgentSession` for the
  cwd, gates the active tools to **read-only + git** (`read`, `grep`, `find`,
  `ls`, `git` — `write`/`edit`/`bash` are excluded), prompts the agent (seeded
  with the form values) for an imagine pass, and maps the Pi event stream:
  `tool_execution_start/update/end` → `progress{tool_execution}` and
  `message_update` (`text_delta` / `thinking_delta`) → `progress{message_update}`.
  Because the agent's write tools are gated off, the **engine** writes `README.md`
  in the cwd from the agent's streamed text, then requests the commit-gate
  decision (`"Commit this README?"` → `["Commit","Revise","Cancel"]`).
- `complete` (decision → done): on a `Commit` choice, `git init` + `add` +
  `commit` the draft via the narrow git tool (`runGit`, SIBYL-004), then reports
  `run_completed{artifacts:["README.md"],decisions:1}`.

The Pi `AgentSession` is reached through a narrow `OriginateSession` port so the
agent-driven core is exercised in CI by a scripted test double emitting the REAL
Pi `AgentSessionEvent` shapes. The production `defaultConnect` boots a session
via `bootSession` with the git tool bound. No new runtime dependencies.

## Why

This is the originate flow's agent-driven core — it proves SIBYL conducts a Pi
agent through a guided task: form values in, a streamed imagine pass mapped to
structured progress, an engine-written README, and a human commit gate.

## Non-goals

- No packaged AEP `/skill:` invocation — v0 drives a GENERIC guided task; the
  `/skill:` path is first proven at L1 (scaffold).
- No live model run in CI (out of scope per the testing approach); the scripted
  double drives the real `EngineRunCore` logic deterministically.
- No modal-form renderer (SIBYL-006/007) and no decision-memory persistence
  (SIBYL-005); the full empty-dir-to-committed-README integration is SIBYL-008.

## Acceptance criteria

1. `submit_form` triggers a prompt that produces a `README.md` draft in the cwd.
2. `tool_execution_*` and `message_update` are surfaced as `progress` events.
3. On completion the engine emits `decision_requested` for the commit gate.

## Verification

- Unit / integration — `test/originate.test.ts` (scripted `OriginateSession`
  double emitting real `AgentSessionEvent`s):
  - the full `submit_form` flow writes `README.md` from the imagine output,
    gates tools to `read,grep,find,ls,git`, seeds the prompt with the form
    values, maps `tool_execution_*` / `message_update` to ordered `progress`
    events, and emits the commit-gate `decision_requested` (criteria 1–3);
  - `complete` actually `git init`/`add`/`commit`s the draft (artifacts +
    a real commit tracking `README.md`);
  - a values-seeded fallback README when the agent streams no text;
  - prompt-failure → `run_failed{agent}` with the session released;
  - `buildImaginePrompt` seeds the values and forbids file writes.
- Full suite green: `tsc --noEmit` + `vitest run` (41 tests).

## Pi API drift vs research doc

- **Tool gating method:** the research doc names `setActiveTools`; the real
  `AgentSession` @ 0.80.2 exposes **`setActiveToolsByName(toolNames: string[])`**
  (plus `getActiveToolNames()` / `getAllTools()`). Used the real method.
- **`message_update` shape:** the doc says it "carries `text_delta` /
  `thinking_delta`"; the real event is
  `{ type:"message_update"; message; assistantMessageEvent }` where the deltas
  live on the nested `assistantMessageEvent` (`{type:"text_delta",delta,...}`).
  Mapped via the nested event.
- **Read-only tool names:** verified `createReadOnlyTools` @ 0.80.2 = `read`,
  `grep`, `find`, `ls`; gate allowlist is those + `git`.
- Otherwise the SDK surface (`session.prompt` / `session.subscribe` /
  `createAgentSession` via `bootSession`) matches the research doc.
