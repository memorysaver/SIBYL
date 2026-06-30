# Pi Integration Research (for SIBYL)

> Captured during `/aep-envision` (2026-06-30) from two research passes over
> [`earendil-works/pi`](https://github.com/earendil-works/pi) `@ main` (packages at **v0.80.2**).
> This is the durable reference for the harness; `/aep-map` and the build agents read it.

## Bottom line

- Pi is a **TypeScript / Node ≥ 22.19** monorepo (Bun also targeted), published to npm as `@earendil-works/*`.
- **Build on Pi, do not fork.** `@earendil-works/pi-tui` is a standalone, reusable TUI library; `@earendil-works/pi-coding-agent` is the agent SDK + extension system.
- SIBYL = a **standalone, custom-rendered TUI** (modal-form mode → story-map mode) that embeds the SDK and renders its own `pi-tui` UI. The driver/engine logic is kept **host-agnostic** behind an **engine↔renderer seam** (the engine emits structured events / decision requests; the TUI is one consumer). This is the "Y" path, chosen from v0 because the product wants a non-chat, form-driven UX.
- Pin Pi packages at **0.80.2** in lockstep. Harness pinned to **Node 22.19 + TS 5.9.x / @types/node 22.19** (Pi's toolchain), kept **out of the Better-T-Stack Bun catalog** (catalog pins `typescript ^6`, which would clash).
- The harness is a **separate process** from the Cloudflare-Workers app (needs TTY, native add-ons, child-process spawn, FS skill discovery — none run in a Worker). Later layers stream results to the oRPC/Workers backend.

## Stack & packages

| Package | Version | Role |
| --- | --- | --- |
| `@earendil-works/pi-tui` | 0.80.2 | Reusable terminal-UI library — own differential renderer (NOT Ink/ratatui). Exports `TUI`, `Container`, `Component`, components (`Box`, `Text`, `Input`, `Editor`, `Markdown`, `Loader`, `SelectList`, `SettingsList`, `Spacer`, `Image`), keybindings, overlays. Ships small native add-ons for keyboard/console detection. |
| `@earendil-works/pi-coding-agent` | 0.80.2 | Agent SDK + extension system + RPC mode + interactive mode. |
| `@earendil-works/pi-agent` / `pi-ai` | 0.80.2 | Lower-level agent loop + event stream. |
| `@earendil-works/pi-orchestrator` | (exp.) | Pi's own orchestration layer — watch for later subagent layers. |

## Driving an agent (SDK)

```ts
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { sibylEngine } from "./engine.ts"; // host-agnostic ExtensionFactory

const loader = new DefaultResourceLoader({ cwd, extensionFactories: [sibylEngine] });
await loader.reload();                                  // discovers .agents/skills/* automatically
const { session } = await createAgentSession({ resourceLoader: loader, sessionManager: SessionManager.create(cwd) });
const unsub = session.subscribe(event => renderer.handle(event));
await session.prompt("/skill:aep-scaffold");           // L1+ ; expands SKILL.md inline
```

- `createAgentSession(config)` → `AgentSession` with `prompt()`, `steer()`, `followUp()`, `subscribe()`, `abort()`, `dispose()`, `setModel()`, `compact()`.
- **Skills** load from `.agents/skills/` (walking to git root) and are invoked as **`/skill:<name>`** (NOT Claude Code's `/<name>`). `prompt("/skill:aep-envision")` expands the SKILL.md body inline into a `<skill>…</skill>` user message (`agent-session.ts._expandSkillCommand`). Verified: `.agents/skills/aep-*` in this repo are discoverable by a Pi agent with `cwd` = repo root.
- Out-of-process alternative: `pi --mode rpc` (JSON-lines over stdio) + `RpcClient` (`onEvent`, `prompt`, `getState`, `getTree`, …). Use if SIBYL ever needs language/process isolation.

## Streaming / progress events

Subscribe via `session.subscribe(listener)`. Event types (`packages/agent/src/types.ts` `AgentEvent`):
- Lifecycle: `agent_start`, `agent_end`, `turn_start`, `turn_end`.
- Message: `message_start`, `message_update` (carries `text_delta` / `thinking_delta`), `message_end`.
- Tools: `tool_execution_start`, `tool_execution_update`, `tool_execution_end`.
- Session layer adds: `queue_update`, `compaction_*`, `session_info_changed`, etc.

Mapping for SIBYL's renderer: `tool_execution_*` = per-step activity; `message_update` = streaming text/thinking; `turn_*` / `agent_*` = phase boundaries.

## Extension API (the engine)

An extension is `(pi: ExtensionAPI) => void` (`ExtensionFactory`), injectable in-process via `DefaultResourceLoader({ extensionFactories: [...] })` — no file on disk. Surface (`packages/coding-agent/src/core/extensions/types.ts`):
- **Events** `pi.on(event, handler)` — result-returning hooks for gating/steering: `tool_call` → `{ block?, reason? }`; `before_agent_start` → inject hidden context / system prompt; `context` → rewrite history; `input` → intercept/transform raw input before skill expansion; plus all lifecycle/tool/message events.
- **Register** `registerTool`/`defineTool` (LLM-callable tools — use a **narrow custom git tool** instead of full bash), `registerCommand` (`/name`), `registerShortcut`, `registerFlag`, `registerMessageRenderer`, `registerProvider`.
- **Drive the loop** `sendUserMessage(text, { deliverAs: "steer"|"followUp"|"nextTurn" })`, `sendMessage(...)`, `setActiveTools/getActiveTools` (tool gating), `appendEntry(customType, data)` — **persists to the session, excluded from the LLM context → this is the decision-memory primitive**.
- **UI** `ctx.ui`: `select`, `confirm`, `input`, `editor` (awaitable dialogs), `custom<T>(factory, { overlay })` (custom multi-field wizard/overlay — **the modal-form primitive**), `setStatus`, `setWidget`, `setFooter/Header`, `theme`. Guard with `ctx.hasUI`.

> **Note:** `plan-mode` and `subagent` live under `packages/coding-agent/examples/extensions/` — **example code, likely excluded from the npm tarball**. Vendor them from the pinned **0.80.2 git tag** into SIBYL, behind a thin SIBYL-owned adapter, with an API-drift smoke test.

## Guided flow + decision capture (the pattern)

From the `plan-mode` example (the template for SIBYL's guided driver):
1. **Gate tools** read-only during framing via `setActiveTools(...)` (+ `tool_call` block hook for bash allowlist).
2. **Steer** the model via `before_agent_start` (inject hidden instructions) and `sendUserMessage(answer, { deliverAs: "followUp" })`.
3. **Decision gate**: at `agent_end` (or `turn_end`), await `ctx.ui.select/confirm/custom(...)` — the await naturally pauses the idle agent.
4. **Capture**: `pi.appendEntry("sibyl-decision", { phase, decision, at })`.
5. **Resume**: `sendUserMessage(...)`.
6. **Restore on resume**: `session_start` scans `ctx.sessionManager.getEntries()` for the custom entries.

For the **modal-form** UX, prefer `ctx.ui.custom<T>(factory, { overlay: true })` (returns the collected result when the component calls `done(value)`) over a chat transcript — or render a full custom screen with `pi-tui` components driven by the engine's events.

## Subagents (later — Layer 6)

`examples/extensions/subagent/` spawns a separate `pi` process per task (isolated context), supports single / parallel (max 8, 4 concurrent) / chained, streams each child's tool calls, tracks per-agent usage. Agents are markdown files with frontmatter in `.pi/agents/*.md`. Adopt/adapt; it is an example, not a built-in tool.

## Runtime constraints & decisions for SIBYL

- New workspace **`apps/harness`** (Node/Bun), add `@earendil-works/pi-coding-agent` + `@earendil-works/pi-tui` @ 0.80.2.
- Harness pinned to Node 22.19 + TS 5.9.x / @types/node 22.19; **excluded from the shared catalog**.
- "Bun also supported" is optimistic for the TUI specifically (raw TTY / native add-ons) — **actually run `pi-tui` under the chosen runtime before committing**.
- Resumability: Pi session state may be in-process only — **verify** whether Pi rehydrates session across a process restart; otherwise treat the `appendEntry` log as the source of truth and "resume" = re-derive position + restart the step.
- Security: `setActiveTools` gates at *tool* granularity; "allow gh" via full bash = a large surface. Prefer a **narrow custom git/gh tool**. Egress limits are not enforced without a sandbox — state the threat model honestly (local-first, trusted operator).

## Key files / links

Pi repo `earendil-works/pi`, `packages/coding-agent/`:
- `src/core/extensions/types.ts` — `ExtensionAPI`, events, `ToolDefinition`, `defineTool`, `ExtensionFactory`.
- `src/core/extensions/loader.ts` — discovery + `loadExtensionFromFactory`.
- `src/core/resource-loader.ts` — `DefaultResourceLoader` (`extensionFactories`, `additionalExtensionPaths`).
- `src/core/agent-session.ts` — `prompt()`, `_expandSkillCommand()`, `steer()`/`followUp()`, `bindExtensions()`.
- `examples/extensions/plan-mode/{index.ts,utils.ts}` — guided-driver template.
- `examples/extensions/subagent/` — subagent pattern.
- `docs/{sdk.md,extensions.md,tui.md,rpc.md,skills.md}`.
- `packages/tui/{src/index.ts,README.md}` — TUI library.
- `packages/agent/src/types.ts` — `AgentEvent`.
