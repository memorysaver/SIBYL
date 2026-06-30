#!/usr/bin/env bash
# select_lessons.sh — enumerate lesson files eligible for the forge.
#
# Default: prints absolute paths of every project-memory/lesson-learned/*/session-*.md
# whose file mtime is ≥ MIN_AGE_DAYS days old (default 7).
#
# Flags:
#   --min-age-days <N>          override the 7-day pre-filter (testing only)
#   --since-last-forge          only include lessons newer than the most recent
#                               forge run (mtime of project-memory/.forge-journal/*.log)
#   --count                     print the count, not the paths
#   --root <path>               override project root (default: git toplevel or PWD)
#   --include-fresh             ignore the age pre-filter (useful for debugging)
#
# Exit codes:
#   0 — at least one lesson selected (or --count printed)
#   1 — no lessons selected
#   2 — usage error

set -euo pipefail

MIN_AGE_DAYS=7
SINCE_LAST_FORGE=0
COUNT_ONLY=0
INCLUDE_FRESH=0
ROOT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --min-age-days=*)   MIN_AGE_DAYS="${1#--min-age-days=}"; shift ;;
    --min-age-days)     MIN_AGE_DAYS="${2:-}"; shift 2 ;;
    --since-last-forge) SINCE_LAST_FORGE=1; shift ;;
    --count)            COUNT_ONLY=1; shift ;;
    --include-fresh)    INCLUDE_FRESH=1; shift ;;
    --root=*)           ROOT="${1#--root=}"; shift ;;
    --root)             ROOT="${2:-}"; shift 2 ;;
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

LESSONS_ROOT="$ROOT/project-memory/lesson-learned"
JOURNAL_DIR="$ROOT/project-memory/.forge-journal"

if [ ! -d "$LESSONS_ROOT" ]; then
  [ "$COUNT_ONLY" -eq 1 ] && echo 0
  exit 1
fi

# Discover all session files (exclude _daily, _INDEX, _CONTEXT).
mapfile -t ALL < <(
  find "$LESSONS_ROOT" -type f -name 'session-*.md' 2>/dev/null | sort
)

# Apply age pre-filter (cheap shell, no LLM).
filter_by_age() {
  local now_epoch min_epoch f f_epoch
  now_epoch="$(date +%s)"
  min_epoch=$(( now_epoch - MIN_AGE_DAYS * 86400 ))
  for f in "${ALL[@]:-}"; do
    [ -z "$f" ] && continue
    # macOS stat -f %m, GNU stat -c %Y. Try both.
    if f_epoch="$(stat -f %m "$f" 2>/dev/null)" || f_epoch="$(stat -c %Y "$f" 2>/dev/null)"; then
      [ "$f_epoch" -le "$min_epoch" ] && echo "$f"
    fi
  done
}

# Apply since-last-forge filter (mtime > most recent journal entry).
filter_since_last_forge() {
  local last_forge_epoch f f_epoch
  if [ ! -d "$JOURNAL_DIR" ]; then
    # No prior forge — everything is "since last forge".
    for f in "${ALL[@]:-}"; do [ -n "$f" ] && echo "$f"; done
    return
  fi
  # Find most recent journal file.
  local latest
  latest="$(find "$JOURNAL_DIR" -maxdepth 1 -type f -name '*.log' 2>/dev/null | sort | tail -n1)"
  if [ -z "$latest" ]; then
    for f in "${ALL[@]:-}"; do [ -n "$f" ] && echo "$f"; done
    return
  fi
  if last_forge_epoch="$(stat -f %m "$latest" 2>/dev/null)" || last_forge_epoch="$(stat -c %Y "$latest" 2>/dev/null)"; then
    for f in "${ALL[@]:-}"; do
      [ -z "$f" ] && continue
      if f_epoch="$(stat -f %m "$f" 2>/dev/null)" || f_epoch="$(stat -c %Y "$f" 2>/dev/null)"; then
        [ "$f_epoch" -gt "$last_forge_epoch" ] && echo "$f"
      fi
    done
  fi
}

# Compose filters.
if [ "$SINCE_LAST_FORGE" -eq 1 ]; then
  PIPELINE="$(filter_since_last_forge)"
elif [ "$INCLUDE_FRESH" -eq 1 ]; then
  PIPELINE="$(printf '%s\n' "${ALL[@]:-}")"
else
  PIPELINE="$(filter_by_age)"
fi

# Drop empty lines.
PIPELINE="$(echo "$PIPELINE" | sed '/^$/d')"

if [ "$COUNT_ONLY" -eq 1 ]; then
  if [ -z "$PIPELINE" ]; then echo 0; else echo "$PIPELINE" | wc -l | tr -d ' '; fi
  exit 0
fi

if [ -z "$PIPELINE" ]; then
  exit 1
fi

echo "$PIPELINE"
exit 0
