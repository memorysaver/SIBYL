#!/usr/bin/env bash
# Workspace Setup Hook — SIBYL (Better-T-Stack: TanStack Start + Hono on Cloudflare
# Workers, Drizzle + D1, Alchemy dev orchestration, Bun + Turborepo).
#
# Called by /aep-build Phase 0 and init.sh (session recovery). Idempotent: safe to
# re-run. Contract: MUST write .dev-workflow/ports.env.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"   # || pwd: don't abort under set -e before git init
cd "$REPO_ROOT"

# ── Detect workspace vs main ──────────────────────────────────────────────────
# AEP runs feature work in git worktrees at .feature-workspaces/<name>/. The first
# `git worktree list` entry is the canonical main checkout.
MAIN_REPO="$(git worktree list --porcelain 2>/dev/null | head -1 | sed 's/^worktree //')" || MAIN_REPO="$REPO_ROOT"
IS_WORKSPACE=false
[ "$REPO_ROOT" != "$MAIN_REPO" ] && IS_WORKSPACE=true

# ── Provision env files (gitignored → absent in fresh worktrees) ──────────────
# Copy from the main checkout when missing so D1/auth/CORS config is present.
ENV_FILES=(apps/server/.env apps/web/.env packages/infra/.env)
for env in "${ENV_FILES[@]}"; do
  if [ ! -f "$env" ]; then
    if [ "$IS_WORKSPACE" = true ] && [ -f "$MAIN_REPO/$env" ]; then
      mkdir -p "$(dirname "$env")"; cp "$MAIN_REPO/$env" "$env"
    elif [ -f "$env.example" ]; then
      cp "$env.example" "$env"
    fi
  fi
done

# ── Install dependencies (idempotent) ─────────────────────────────────────────
bun install

# ── Port scanning (parallel workspace isolation) ──────────────────────────────
# server dev port is the controllable one (alchemy.run.ts dev.port); web (vite)
# takes the next free port. Step by 10 so parallel workspaces never collide.
SERVER_PORT=3000
WEB_PORT=$((SERVER_PORT + 1))
while lsof -i :"$SERVER_PORT" -sTCP:LISTEN >/dev/null 2>&1 || \
      lsof -i :"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  SERVER_PORT=$((SERVER_PORT + 10))
  WEB_PORT=$((SERVER_PORT + 1))
done

# Portable in-place sed (works on BSD/macOS and GNU sed).
sedi() { sed -i.bak "$@" && rm -f "${@: -1}.bak"; }

# ── Inject assigned ports when shifted from defaults (3000/3001) ──────────────
if [ "$SERVER_PORT" != "3000" ]; then
  # server dev port
  sedi "s|port: 3000|port: ${SERVER_PORT}|" packages/infra/alchemy.run.ts
  # cross-references in env files
  [ -f apps/server/.env ] && {
    sedi "s|^BETTER_AUTH_URL=.*|BETTER_AUTH_URL=http://localhost:${SERVER_PORT}|" apps/server/.env
    sedi "s|^CORS_ORIGIN=.*|CORS_ORIGIN=http://localhost:${WEB_PORT}|" apps/server/.env
  }
  [ -f apps/web/.env ] && sedi "s|^VITE_SERVER_URL=.*|VITE_SERVER_URL=http://localhost:${SERVER_PORT}|" apps/web/.env
fi

# ── Write ports.env (CONTRACT — required) ─────────────────────────────────────
mkdir -p .dev-workflow
cat > .dev-workflow/ports.env <<EOF
SERVER_PORT=$SERVER_PORT
WEB_PORT=$WEB_PORT
SERVER_URL=http://localhost:$SERVER_PORT
BASE_URL=http://localhost:$WEB_PORT
EOF

# ── Start dev server (best-effort; alchemy dev runs D1 migrations + serves) ───
# `bun run dev` is a persistent task — background it and don't let a slow start
# abort the hook.
if ! lsof -i :"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  ( nohup bun run dev >.dev-workflow/dev.log 2>&1 & ) || true
  echo "Dev server starting in background (logs: .dev-workflow/dev.log)"
fi

# ── Seed database (canonical e2e seed; symlinks resolve to skills/e2e-test) ───
SEED="$REPO_ROOT/skills/e2e-test/scripts/seed.sh"
[ -f "$SEED" ] && bash "$SEED" || true

echo "Setup complete. Server: http://localhost:$SERVER_PORT  Web: http://localhost:$WEB_PORT"
