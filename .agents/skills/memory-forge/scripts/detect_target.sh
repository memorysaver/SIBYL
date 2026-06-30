#!/usr/bin/env bash
# detect_target.sh — figure out where extracted skills should land in the host project.
#
# Prints a single TSV line on stdout: <rule-number>\t<absolute-target-dir>
#   rule 1: canonical layout (skills/ + .claude/skills symlink)        → <root>/skills/<group>/
#   rule 2: flat Claude Code (.claude/skills is a real dir)            → <root>/.claude/skills/
#   rule 3: Codex (.codex/skills is a real dir)                        → <root>/.codex/skills/
#   rule 4: agents.md-spec (.agents/skills is a real dir)              → <root>/.agents/skills/
#   rule 5: none of the above — create <root>/.claude/skills/ fresh    → <root>/.claude/skills/
#
# Use --explain to print a human-readable diagnostic to stderr.
# Use --root <path> to override the project root (default: git toplevel, or PWD).
# Override the whole detection with MEMORY_FORGE_TARGET=<absolute-path>.
#
# Group for rule 1 defaults to "memory"; override with MEMORY_FORGE_GROUP=<name>.

set -euo pipefail

EXPLAIN=0
ROOT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --explain) EXPLAIN=1; shift ;;
    --root=*)  ROOT="${1#--root=}"; shift ;;
    --root)    ROOT="${2:-}"; shift 2 ;;
    --help|-h)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$ROOT" ]; then
  if ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then :; else ROOT="$PWD"; fi
fi
ROOT="$(cd "$ROOT" && pwd -P)"

explain() { [ "$EXPLAIN" -eq 1 ] && echo "detect_target: $*" >&2 || true; }

# Override short-circuit.
if [ -n "${MEMORY_FORGE_TARGET:-}" ]; then
  explain "MEMORY_FORGE_TARGET set, using $MEMORY_FORGE_TARGET"
  printf '0\t%s\n' "$MEMORY_FORGE_TARGET"
  exit 0
fi

GROUP="${MEMORY_FORGE_GROUP:-memory}"

# Rule 1: canonical layout.
if [ -d "$ROOT/skills" ] && [ ! -L "$ROOT/skills" ]; then
  if [ -L "$ROOT/.claude/skills" ] || [ -d "$ROOT/.claude/skills" ]; then
    explain "rule 1 — canonical layout (skills/ real dir + .claude/skills present)"
    printf '1\t%s\n' "$ROOT/skills/$GROUP"
    exit 0
  fi
fi

# Rule 2: flat Claude Code.
if [ -d "$ROOT/.claude/skills" ] && [ ! -L "$ROOT/.claude/skills" ]; then
  explain "rule 2 — flat .claude/skills real dir"
  printf '2\t%s\n' "$ROOT/.claude/skills"
  exit 0
fi

# Rule 3: Codex.
if [ -d "$ROOT/.codex/skills" ] && [ ! -L "$ROOT/.codex/skills" ]; then
  explain "rule 3 — .codex/skills real dir"
  printf '3\t%s\n' "$ROOT/.codex/skills"
  exit 0
fi

# Rule 4: agents.md-spec.
if [ -d "$ROOT/.agents/skills" ] && [ ! -L "$ROOT/.agents/skills" ]; then
  explain "rule 4 — .agents/skills real dir"
  printf '4\t%s\n' "$ROOT/.agents/skills"
  exit 0
fi

# Rule 5: fallback — create a fresh .claude/skills.
explain "rule 5 — no discovery infrastructure found; defaulting to .claude/skills/"
printf '5\t%s\n' "$ROOT/.claude/skills"
exit 0
