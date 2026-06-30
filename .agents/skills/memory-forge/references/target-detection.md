# Target detection

Where does the forge write its extracted skills? It depends on how the host project loads skills, which varies by agent harness. `scripts/detect_target.sh` encodes the rules below.

## Why generic detection

`memory-forge` is project-scoped — the extracted skills are loaded by whoever is working in *this* project next. The skill files have to land where the agent actually scans for skills. Different host projects use different layouts:

- Some use the **canonical layout** (real `skills/` + symlinks under `.claude/skills`, `.agents/skills`).
- Some have a **flat `.claude/skills/<name>/SKILL.md`** directly.
- Codex agents read from **`.codex/skills/<name>/`**.
- agents.md-spec scanners read from **`.agents/skills/<name>/`**.
- A fresh project may have **none of the above** yet.

Hardcoding any one of these would silently break detection on the others. The forge auto-detects and reports its target before writing.

## Detection rules (in order)

The script checks each in order and stops at the first match. Project root is the git repo root (`git rev-parse --show-toplevel`), falling back to the CWD if not in a git repo.

### 1. Canonical layout

**Condition:** `<root>/skills/` is a real directory AND `<root>/.claude/skills` is a symlink (passthrough or directory of per-skill symlinks pointing into `skills/`).

**Output target:** `<root>/skills/memory/<forged-name>/`

**Rationale:** This is the layout described in the `canonical-project-skills-layout` skill, used by repos like `memorysaver/skills` itself. New skills go under a group (`skills/memory/`), and discovery is handled by `.claude/skills` / `.agents/skills` symlinks. If the project has a `scripts/link-skills.sh`, the forge calls it after writing — that's the project's own convention for refreshing symlinks.

**Group name choice:** Default is `memory` (mirrors `project-memory` and `memory-forge` themselves). If the host project has a different convention (e.g. `lessons/`, `learned/`), the forge respects an explicit `MEMORY_FORGE_GROUP` env var.

### 2. Flat Claude Code

**Condition:** `<root>/.claude/skills/` is a real directory (not a symlink) AND rule 1 didn't match.

**Output target:** `<root>/.claude/skills/<forged-name>/`

**Rationale:** Simplest, most universal Claude Code layout. Each skill is a self-contained directory directly under `.claude/skills/`.

### 3. Codex

**Condition:** `<root>/.codex/skills/` is a real directory AND rules 1–2 didn't match.

**Output target:** `<root>/.codex/skills/<forged-name>/`

**Rationale:** Codex CLI looks for skills under `.codex/skills/`. Same internal structure as Claude Code skills (`SKILL.md` + supporting files), just a different discovery root.

### 4. agents.md-spec

**Condition:** `<root>/.agents/skills/` is a real directory AND rules 1–3 didn't match.

**Output target:** `<root>/.agents/skills/<forged-name>/`

**Rationale:** The agents.md spec (open standard) puts skills under `.agents/skills/`. Useful for projects that want harness-agnostic discovery.

### 5. Fallback — no discovery infrastructure yet

**Condition:** None of the above directories exist.

**Output target:** `<root>/.claude/skills/<forged-name>/` (created fresh)

**Rationale:** Claude Code is the most common Claude-family harness, and a brand-new `.claude/skills/` directory is the most likely to be picked up automatically by the next agent that walks into the repo. The forge prints a one-liner explaining that this fresh directory was created and that the user can move it later if they prefer a different layout.

## What detection prints

`scripts/detect_target.sh` writes a single line to stdout:

```
<rule-number>\t<absolute-target-path>
```

For example:

```
1	/Users/me/work/web-app/skills/memory/cache-invalidation
```

The first number lets downstream scripts and the user see which rule fired, without re-running the detection. Use `--explain` to also emit a human-readable diagnostic to stderr.

## When the target is ambiguous

The rules above are strictly ordered to avoid ambiguity. But two real-world cases are worth calling out:

- **Project has BOTH `skills/` and a flat `.claude/skills/<some-skill>/SKILL.md`** (mixed layout). Rule 1 wins — the canonical layout is the more deliberate setup. The forge will not migrate the existing flat skill; it just writes new ones into the canonical tree.
- **`.claude/skills` is a passthrough symlink to `../skills` but there's no per-skill symlink** (older canonical setup). Rule 1 still wins. The forge writes into `skills/memory/<name>/`, and any project-side `link-skills.sh` will rebuild the per-skill symlinks. If no such script exists, the forge writes the symlinks itself as a one-time fix-up.

## Override

For testing, scripting, or unusual projects, set `MEMORY_FORGE_TARGET=<absolute-path>` to bypass detection entirely. The path is treated as a real directory; the forge creates `<path>/<forged-name>/` under it.
