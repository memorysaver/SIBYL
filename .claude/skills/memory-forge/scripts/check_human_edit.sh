#!/usr/bin/env bash
# check_human_edit.sh — has a forged SKILL.md been hand-edited since the forge wrote it?
#
# Compares sha256 of the current body against metadata.origin_hash.
#   exit 0 — untouched (forge may rewrite body)
#   exit 1 — human-edited (forge must NOT rewrite body; references/ appends still OK)
#   exit 2 — other error (file missing, no frontmatter, wrong origin, etc.)
#
# Usage:
#   check_human_edit.sh <path/to/SKILL.md>
#
# Requires: python3 + PyYAML.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <path/to/SKILL.md>" >&2
  exit 2
fi

SKILL_MD="$1"
if [ ! -f "$SKILL_MD" ]; then
  echo "Not a file: $SKILL_MD" >&2
  exit 2
fi

python3 - "$SKILL_MD" <<'PY'
import sys, hashlib, yaml
path = sys.argv[1]
with open(path) as f:
    text = f.read()
parts = text.split("---", 2)
if len(parts) < 3:
    print(f"{path}: no YAML frontmatter", file=sys.stderr)
    sys.exit(2)
fm = yaml.safe_load(parts[1]) or {}
meta = fm.get("metadata") or {}
if meta.get("origin") != "memory-forge":
    print(f"{path}: origin is {meta.get('origin')!r}, not 'memory-forge'", file=sys.stderr)
    sys.exit(2)
recorded = meta.get("origin_hash")
if not recorded:
    print(f"{path}: no origin_hash recorded", file=sys.stderr)
    sys.exit(2)
body = parts[2]
current = hashlib.sha256(body.encode()).hexdigest()
if current == recorded:
    print(f"untouched: {path}")
    sys.exit(0)
else:
    print(f"human-edited: {path}")
    print(f"  recorded: {recorded[:16]}...")
    print(f"  current:  {current[:16]}...")
    sys.exit(1)
PY
