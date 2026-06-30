# SIBYL-001 — Tasks

- [x] Verify the Pi package is real and usable: install
      `@earendil-works/pi-coding-agent@0.80.2` and confirm `createAgentSession`,
      `DefaultResourceLoader`, `SessionManager`, `ExtensionFactory`,
      `extensionFactories` exist and import under the chosen runtime.
- [x] Scaffold `apps/harness` (package.json + tsconfig), pinned out of the Bun
      catalog: Node `>=22.19`, TS ~5.9, `@types/node` ~22.19, Pi pinned `0.80.2`.
- [x] Implement `createSibylEngineExtension()` — minimal binding stub.
- [x] Implement `bootSession(cwd)` — loader (extensionFactories + agentDir) →
      reload → `createAgentSession`.
- [x] Implement `discoverSkills(cwd)` — loader.getSkills() over `.agents/skills`.
- [x] Unit test: `bootSession` returns a session bound to the SIBYL
      engine-extension (marker command registered, no load errors).
- [x] Integration test: skill discovery finds `aep-envision` from
      `.agents/skills`.
- [x] Green: install, `tsc --noEmit` (build/check-types), and `vitest run` pass.
- [x] Lint/format clean (oxlint + oxfmt).
- [x] PR with test evidence + Pi API drift notes.
