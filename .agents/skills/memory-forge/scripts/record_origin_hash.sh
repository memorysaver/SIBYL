#!/usr/bin/env bash
# record_origin_hash.sh — stamp metadata.origin_hash on a forged SKILL.md.
#
# Computes sha256 of the body (everything below the closing --- of the frontmatter)
# and writes it into metadata.origin_hash. Idempotent — running it twice on an
# unchanged file produces the same hash.
#
# Usage:
#   record_origin_hash.sh <path/to/SKILL.md>
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
  exit 1
fi

python3 - "$SKILL_MD" <<'PY'
import sys, hashlib, yaml
path = sys.argv[1]
with open(path) as f:
    text = f.read()
parts = text.split("---", 2)
if len(parts) < 3:
    sys.exit(f"No YAML frontmatter in {path}")
fm = yaml.safe_load(parts[1]) or {}
body = parts[2]
meta = fm.setdefault("metadata", {})
if meta.get("origin") != "memory-forge":
    sys.exit(f"{path}: metadata.origin is not 'memory-forge'; refusing to stamp.")
body_hash = hashlib.sha256(body.encode()).hexdigest()
meta["origin_hash"] = body_hash
new_fm = yaml.safe_dump(fm, sort_keys=False).rstrip()
with open(path, "w") as f:
    f.write("---\n" + new_fm + "\n---" + body)
print(f"stamped origin_hash={body_hash[:12]}... on {path}")
PY
