---
name: project-behavior
description: Author or update a project's AGENTS.md to install behavioral guidelines that govern any agent acting in that project. Use when the user wants to configure project-level agent behavior, set up or extend AGENTS.md, add a behavioral floor, prepend a coding-discipline preamble, or apply a named behavior pack to a project. Bundles the Karpathy behavioral preamble as one reference pack and supports adding more. Trigger phrases include "set up AGENTS.md", "configure agent behavior", "add behavioral guidelines", "add karpathy preamble", "install behavior pack", "create AGENTS.md", "control how agents behave in this repo".
license: Apache-2.0
version: 0.1.0
---

# project-behavior

Bootstrap or extend a project's `AGENTS.md` with one or more *behavior packs* — short, opinionated preambles that set the rules agents must follow when working in the project. Karpathy's four-section preamble is included as the default pack; additional packs can be added by dropping more files into `references/`.

## When to invoke

- Brand-new project that needs an `AGENTS.md` from scratch.
- Existing `AGENTS.md` that lacks a behavioral preamble.
- Switching or stacking behavior packs (e.g. add a security-focused pack on top of Karpathy).
- Pairing with [`canonical-project-skills-layout`](../canonical-project-skills-layout/SKILL.md): that skill enforces the file *layout* (where `AGENTS.md` lives, that `CLAUDE.md` is `@AGENTS.md`); this skill controls the *content* of `AGENTS.md`.

## Workflow

1. **Locate the guide.** Look for `<project>/AGENTS.md`. If it doesn't exist but `<project>/CLAUDE.md` does, ask whether to (a) rename/promote `CLAUDE.md` to `AGENTS.md` and replace `CLAUDE.md` with `@AGENTS.md`, or (b) write directly into `CLAUDE.md`. The canonical answer is (a); recommend it unless the user is on a Claude-only project.

2. **Detect existing preamble.** Read the first ~30 lines of `AGENTS.md`. If the H1 is `# Agent behavioral guidelines` or any pack's first line is already present verbatim, *the preamble is installed* — skip ahead and ask whether to add another pack on top, swap it, or exit.

3. **Pick pack(s).** List the files under `references/` to the user with a one-line summary of each. Default: `karpathy.md`. Allow multi-select for stacking.

4. **Compose the preamble.** For each chosen pack, append its content in the order picked. Between packs and between the preamble and the rest of the file, insert a horizontal `---` separator on its own line.

5. **Render to disk.** Use `Edit` (or `Write` only for new files). Prepend the composed preamble *before* the existing top-level H1 of the project. Preserve every byte of the existing project-specific content below the preamble.

6. **Verify.** Re-read the top of the file. Confirm the first H1 is `# Agent behavioral guidelines`, that each selected pack appears once, and that a `---` separates the preamble from the existing project content.

## Rules for the rendered output

- **No source/attribution line.** Do not paste a "Source: ..." reference into `AGENTS.md`. The provenance of each pack is documented inside the pack file itself for the skill author, not for end users of the project.
- **Idempotent.** Re-running the skill on a project that already has a given pack must not duplicate it.
- **Stack with `---`.** Multiple packs stack vertically, separated by `---`. The project-specific content begins after the final `---`.
- **Preserve project content.** Never edit content below the preamble. If the user wants to change project-specific sections, that's a separate task.

## Adding a new reference pack

To extend this skill with a new behavior pack:

1. Write `references/<pack-name>.md` containing only the rendered preamble content — what should land in `AGENTS.md` verbatim. Start with an H1 (recommend `# Agent behavioral guidelines` so the existing detection signal still works) and a 1-line tagline; structure the rest as numbered H2 sections.
2. The first commented line of the file may carry an HTML comment with source/attribution for traceability (`<!-- source: ... -->`). The skill must strip any HTML comment block when copying into `AGENTS.md`.
3. No code changes required — `references/` is auto-listed at step 3 of the workflow.

## References

- `references/karpathy.md` — Karpathy's four-section behavioral preamble (Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution). Default pack.
