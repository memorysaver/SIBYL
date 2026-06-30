#!/usr/bin/env bash
# Seed — deterministic fixture for the test account/database (SIBYL).
# Idempotent: re-runs converge to the same fixture (re-runs should print "exists" rows, not error).
# Called by .claude/hooks/workspace-setup.sh after the dev server starts, and by journey dogfoods.
#
# Local dev (default; reads .dev-workflow/ports.env when present):
#   bash skills/e2e-test/scripts/seed.sh
# Target a deployed env (prefix any secret env assignments — VAR=value, not bare names):
#   SERVER_URL=<url> [SECRET=value …] bash skills/e2e-test/scripts/seed.sh
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
EXPLICIT_SERVER_URL="${SERVER_URL:-}"
if [ -f "$REPO_ROOT/.dev-workflow/ports.env" ]; then
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.dev-workflow/ports.env"
fi
# An explicitly passed SERVER_URL wins over ports.env (deployed-env targeting).
SERVER_URL="${EXPLICIT_SERVER_URL:-${SERVER_URL:-http://localhost:3000}}"

# Wait briefly for the server — best-effort, and ONLY when a server target is configured.
# This is a cli project (dogfood_target: cli) with no server, so skip the wait unless a SERVER_URL
# or .dev-workflow/ports.env is explicitly present (e.g. once an L7 web surface ships).
if [ -n "$EXPLICIT_SERVER_URL" ] || [ -f "$REPO_ROOT/.dev-workflow/ports.env" ]; then
  echo "Waiting for server at $SERVER_URL..."
  up=false
  for _ in $(seq 1 10); do
    curl -s "$SERVER_URL" >/dev/null 2>&1 && { up=true; break; }
    sleep 1
  done
  [ "$up" = true ] || echo "  server not reachable — continuing (best-effort seed)"
else
  echo "No server target (cli project) — skipping server wait."
fi

# ── PROJECT-SPECIFIC: DB migrations ──
# e.g.  bun run db:migrate
# (no-op on a fresh scaffold — fill in once the schema exists)

# ── PROJECT-SPECIFIC: test account / fixture ──
# Use the public API (idempotent), not raw SQL. Example:
#   curl -s -X POST "$SERVER_URL/api/<seed-endpoint>" -H 'content-type: application/json' -d '{...}' >/dev/null
# (no-op on a fresh scaffold)

echo "Seed complete."
