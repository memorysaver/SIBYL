#!/usr/bin/env bash
# apply_forge.sh — apply a `## Structured summary` block to the host project.
#
# Reads the structured summary from stdin (the full forge-prompt output is fine —
# the script only parses the YAML inside the `## Structured summary` heading).
# Writes new skills, appends references, and demotes pruned skills, idempotently.
#
# Flags:
#   --dry-run            parse and report actions, write nothing
#   --rollback <stamp>   undo a prior run by replaying its journal entry in reverse
#   --root <path>        override project root
#
# Requires: python3 with PyYAML installed (pip install pyyaml).
#
# Writes a journal entry to project-memory/.forge-journal/<UTC-timestamp>.log.

set -euo pipefail

SOURCE="${BASH_SOURCE[0]:-$0}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  LINK="$(readlink "$SOURCE")"
  case "$LINK" in
    /*) SOURCE="$LINK" ;;
    *)  SOURCE="$DIR/$LINK" ;;
  esac
done
SKILL_DIR="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"

DRY_RUN=0
ROLLBACK_STAMP=""
ROOT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)     DRY_RUN=1; shift ;;
    --rollback=*)  ROLLBACK_STAMP="${1#--rollback=}"; shift ;;
    --rollback)    ROLLBACK_STAMP="${2:-}"; shift 2 ;;
    --root=*)      ROOT="${1#--root=}"; shift ;;
    --root)        ROOT="${2:-}"; shift 2 ;;
    --help|-h)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$ROOT" ]; then
  if ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then :; else ROOT="$PWD"; fi
fi
ROOT="$(cd "$ROOT" && pwd -P)"

JOURNAL_DIR="$ROOT/project-memory/.forge-journal"
mkdir -p "$JOURNAL_DIR"

# --- Rollback path ---
if [ -n "$ROLLBACK_STAMP" ]; then
  JOURNAL_FILE="$JOURNAL_DIR/$ROLLBACK_STAMP.log"
  if [ ! -f "$JOURNAL_FILE" ]; then
    echo "No journal entry at $JOURNAL_FILE" >&2
    exit 1
  fi
  echo "Rolling back $JOURNAL_FILE..."
  # Lines: ACTION <tab> path1 [<tab> path2]
  #   CREATE_SKILL <dir>          → rm -rf <dir>
  #   APPEND_REF   <file>         → rm -f <file>
  #   PRUNE        <orig> <dest>  → mv <dest> <orig>
  while IFS=$'\t' read -r action a b; do
    case "$action" in
      CREATE_SKILL) [ "$DRY_RUN" -eq 0 ] && rm -rf "$a"; echo "  removed $a" ;;
      APPEND_REF)   [ "$DRY_RUN" -eq 0 ] && rm -f "$a"; echo "  removed $a" ;;
      PRUNE)        [ "$DRY_RUN" -eq 0 ] && { mkdir -p "$(dirname "$a")"; mv "$b" "$a"; }; echo "  restored $a" ;;
    esac
  done < "$JOURNAL_FILE"
  [ "$DRY_RUN" -eq 0 ] && mv "$JOURNAL_FILE" "$JOURNAL_FILE.rolled-back"
  exit 0
fi

# Detect target (write target dir to TARGET_DIR).
TARGET_LINE="$(bash "$SKILL_DIR/scripts/detect_target.sh" --root "$ROOT")"
TARGET_RULE="${TARGET_LINE%%	*}"
TARGET_DIR="${TARGET_LINE#*	}"
echo "Target: rule $TARGET_RULE → $TARGET_DIR" >&2

# Prepare paths for python to write to.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
JOURNAL_FILE="$JOURNAL_DIR/$STAMP.log"
[ "$DRY_RUN" -eq 0 ] && : > "$JOURNAL_FILE"

# Hand off to the inner python worker. The inner script reads the full
# forge-prompt output from stdin (which is whatever was piped into this
# shell script).
exec python3 "$SKILL_DIR/scripts/_apply_forge_inner.py" \
  "$ROOT" "$TARGET_DIR" "$JOURNAL_FILE" "$DRY_RUN"
