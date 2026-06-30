#!/usr/bin/env bash
# cluster_lessons.sh — group lesson files by recurring theme.
#
# Reads a newline-separated list of lesson file paths on stdin (as produced by
# select_lessons.sh). Prints clusters on stdout, one cluster per "## cluster"
# block:
#
#   ## cluster
#   theme: <short slug or label>
#   members:
#     - <path 1>
#     - <path 2>
#   shared_tags: <comma-separated>
#   ## end-cluster
#
# Strategy:
#   1. If qmd is on PATH and a memory collection is registered for this project,
#      use `qmd vsearch` to compute pairwise neighborhoods.
#   2. Otherwise, fall back to tag-based grouping: lessons share a cluster if
#      they share ≥1 tag from the `tags:` frontmatter list (or any of the slug
#      tokens if no tags field is present).
#
# Output is deterministic across runs given identical inputs.
#
# Flags:
#   --min-cluster-size <N>   only emit clusters with ≥N members (default 2)
#   --strategy <auto|qmd|tags>  force a strategy (default auto)
#   --root <path>            override project root

set -euo pipefail

MIN_CLUSTER_SIZE=2
STRATEGY="auto"
ROOT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --min-cluster-size=*) MIN_CLUSTER_SIZE="${1#--min-cluster-size=}"; shift ;;
    --min-cluster-size)   MIN_CLUSTER_SIZE="${2:-}"; shift 2 ;;
    --strategy=*)         STRATEGY="${1#--strategy=}"; shift ;;
    --strategy)           STRATEGY="${2:-}"; shift 2 ;;
    --root=*)             ROOT="${1#--root=}"; shift ;;
    --root)               ROOT="${2:-}"; shift 2 ;;
    --help|-h)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$ROOT" ]; then
  if ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then :; else ROOT="$PWD"; fi
fi
ROOT="$(cd "$ROOT" && pwd -P)"

# Read inputs from stdin.
mapfile -t LESSONS < <(cat | sed '/^$/d')
[ "${#LESSONS[@]}" -eq 0 ] && exit 0

# Strategy selection.
have_qmd=0
if command -v qmd >/dev/null 2>&1; then have_qmd=1; fi

case "$STRATEGY" in
  auto) [ "$have_qmd" -eq 1 ] && STRATEGY="qmd" || STRATEGY="tags" ;;
  qmd|tags) ;;
  *) echo "Unknown strategy: $STRATEGY" >&2; exit 2 ;;
esac

# Extract tags from a lesson file's frontmatter.
# Prints tags as one-per-line. If no `tags:` field, falls back to slug tokens.
lesson_tags() {
  local file="$1"
  # Pull `tags: [...]` or `tags:\n  - ...` from frontmatter (first 40 lines).
  awk '
    NR <= 40 {
      if ($0 ~ /^tags:/) {
        # Inline list form: tags: [a, b, c]
        if (match($0, /\[.*\]/)) {
          gsub(/.*\[|\].*|"|'\''/, "", $0)
          gsub(/,/, "\n", $0)
          print $0
          in_block = 0
        } else {
          in_block = 1
        }
        next
      }
      if (in_block) {
        if ($0 ~ /^[a-zA-Z_]+:/) { in_block = 0; next }
        if ($0 ~ /^  *- /) {
          sub(/^  *- */, "", $0)
          gsub(/"|'\''/, "", $0)
          print $0
        }
      }
    }
  ' "$file" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | sed '/^$/d'

  # If no tags found, derive tokens from the slug (filename).
  local base
  base="$(basename "$file" .md)"
  # session-1432-cache-bust → cache,bust (drop session-NNNN- prefix).
  base="$(echo "$base" | sed -E 's/^session-[0-9]+-//')"
  echo "$base" | tr '-' '\n' | sed '/^$/d'
}

emit_cluster() {
  local theme="$1"; shift
  local members=("$@")
  [ "${#members[@]}" -lt "$MIN_CLUSTER_SIZE" ] && return
  echo "## cluster"
  echo "theme: $theme"
  echo "members:"
  for m in "${members[@]}"; do echo "  - $m"; done
  # Shared tags = intersection.
  local first=1 shared=""
  for m in "${members[@]}"; do
    local tags
    tags="$(lesson_tags "$m" | sort -u | tr '\n' ',' | sed 's/,$//')"
    if [ "$first" -eq 1 ]; then shared="$tags"; first=0
    else
      # Intersect shared and tags.
      shared="$(echo "$shared" | tr ',' '\n' | grep -Fx -f <(echo "$tags" | tr ',' '\n') | tr '\n' ',' | sed 's/,$//')"
    fi
  done
  echo "shared_tags: $shared"
  echo "## end-cluster"
  echo ""
}

cluster_by_tags() {
  # Build: tag -> list of files. Then emit one cluster per tag with ≥MIN files.
  declare -A TAG_TO_FILES
  for f in "${LESSONS[@]}"; do
    local tag
    while IFS= read -r tag; do
      [ -z "$tag" ] && continue
      # Skip generic tokens that won't cluster meaningfully.
      case "$tag" in 1|2|3|the|and|of|to|in|on|by|for|with) continue ;; esac
      TAG_TO_FILES["$tag"]="${TAG_TO_FILES["$tag"]:-}$f"$'\n'
    done < <(lesson_tags "$f" | sort -u)
  done

  # Track which (tag, members) signatures we've already emitted to avoid dupes
  # when two tags co-occur on the exact same set of files.
  declare -A SEEN_SIG
  for tag in $(echo "${!TAG_TO_FILES[@]}" | tr ' ' '\n' | sort); do
    mapfile -t members < <(echo -n "${TAG_TO_FILES[$tag]}" | sed '/^$/d' | sort -u)
    [ "${#members[@]}" -lt "$MIN_CLUSTER_SIZE" ] && continue
    local sig
    sig="$(printf '%s\n' "${members[@]}" | sha1sum | cut -d' ' -f1)"
    [ -n "${SEEN_SIG[$sig]:-}" ] && continue
    SEEN_SIG[$sig]=1
    emit_cluster "$tag" "${members[@]}"
  done
}

cluster_by_qmd() {
  local collection
  collection="$(basename "$ROOT")-memory"
  # For each lesson, ask qmd for nearest neighbors and treat any pair that
  # appears in each other's top-K as belonging to the same cluster.
  local K=5
  declare -A NEIGHBORS
  for f in "${LESSONS[@]}"; do
    local rel
    rel="${f#"$ROOT"/}"
    local neighbors
    if ! neighbors="$(qmd vsearch "$rel" -c "$collection" --top "$K" 2>/dev/null | awk 'NR>1 {print $1}')"; then
      neighbors=""
    fi
    NEIGHBORS["$f"]="$neighbors"
  done

  # Union-find by symmetric neighborhood.
  declare -A PARENT
  for f in "${LESSONS[@]}"; do PARENT["$f"]="$f"; done
  find_root() {
    local x="$1"
    while [ "${PARENT[$x]}" != "$x" ]; do x="${PARENT[$x]}"; done
    echo "$x"
  }
  union() {
    local a b
    a="$(find_root "$1")"; b="$(find_root "$2")"
    [ "$a" != "$b" ] && PARENT["$a"]="$b"
  }

  for f in "${LESSONS[@]}"; do
    while IFS= read -r n; do
      [ -z "$n" ] && continue
      n_abs="$ROOT/$n"
      # Symmetric check: is f in n's neighborhood too?
      if echo "${NEIGHBORS[$n_abs]:-}" | grep -qxF "${f#"$ROOT"/}"; then
        union "$f" "$n_abs"
      fi
    done <<< "${NEIGHBORS[$f]:-}"
  done

  # Group by root.
  declare -A GROUPS
  for f in "${LESSONS[@]}"; do
    local r
    r="$(find_root "$f")"
    GROUPS["$r"]="${GROUPS[$r]:-}$f"$'\n'
  done

  for r in "${!GROUPS[@]}"; do
    mapfile -t members < <(echo -n "${GROUPS[$r]}" | sed '/^$/d' | sort -u)
    [ "${#members[@]}" -lt "$MIN_CLUSTER_SIZE" ] && continue
    emit_cluster "$(basename "$r" .md | sed -E 's/^session-[0-9]+-//')" "${members[@]}"
  done
}

case "$STRATEGY" in
  qmd)  cluster_by_qmd ;;
  tags) cluster_by_tags ;;
esac
