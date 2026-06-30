# SIBYL

A specification-bound control surface for agentic engineering.

SIBYL is an early-stage design effort for a more deterministic agent harness. It takes the premise of Agentic Engineering Patterns (AEP) seriously: when agent execution becomes abundant, ambiguity becomes the system bottleneck. The project exists to turn product intent into explicit contracts, bounded execution units, verification gates, and repeatable loops.

This repository is not an operator manual yet. It is the starting document for the system we will design through AEP.

## Why SIBYL

SIBYL is pronounced **"sib-uhl"**, like the English word *sibyl*. The name points at ancient figures who interpreted uncertain futures, but the project is deliberately not mystical. SIBYL is not about letting agents guess what a product should become. It is about reducing surprise by turning ambiguous product intent into explicit specifications, bounded work units, verification gates, and repeatable execution loops.

**SIBYL is not an oracle. It is a control surface for agentic engineering.**

The name can also be read as **Specification-Bound Intelligent Yield Loop**. Specification-Bound means agent runs are constrained by explicit contracts instead of vague prompts. Intelligent acknowledges that reasoning agents do useful work inside the system, while the harness limits where that reasoning is allowed to operate. Yield is the engineering output of the loop: code, artifacts, decisions, lessons, and validated changes. Loop is the feedback cycle where each run updates the system's understanding and makes the next execution less ambiguous.

The goal is not prophecy. The goal is an execution system with fewer hidden variables.

## Premise

Agentic engineering changes the constraint surface.

The limiting factor is no longer only how quickly a person can type code. A modern coding agent can attempt many changes, run tools, branch execution, and keep working long after a human would have stopped for context. The bottleneck moves upstream: unclear intent, unstable scope, missing contracts, weak verification, and feedback that never becomes part of the next run.

SIBYL starts from a stricter rule:

> Agents should be free to execute, but not free to invent the system they are executing against.

The harness exists to reduce ambiguity before execution, constrain autonomy during execution, and harvest evidence after execution.

## What SIBYL Is

SIBYL is a deterministic harness inspired by [Agentic Engineering Patterns](https://github.com/memorysaver/agentic-engineering-patterns). AEP provides the product and workflow discipline: envision, map, design, dispatch, build, wrap, and reflect. SIBYL is the attempt to make that discipline executable as a stronger control loop.

The system is expected to organize agent work around:

- explicit specifications instead of ambient prompts
- bounded work units instead of open-ended tasks
- isolated runs with readable state transitions
- verification gates before work is accepted
- event and state traces that can be inspected after the fact
- feedback loops that convert lessons into sharper future runs

The execution substrate is planned around [Pi coding-agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent), using its SDK and process-integration surfaces as the basis for a harness that can spawn, observe, and constrain coding agents without forking Pi internals.

SIBYL should feel less like chatting with a model and more like operating a control system.

## What SIBYL Is Not

SIBYL is not an oracle. It does not claim to predict the right product, decide the roadmap, or replace human judgment.

SIBYL is not a chatroom-style agent swarm. Agents should not coordinate by improvising in conversation. They should communicate through artifacts, contracts, signals, and verified state.

SIBYL is not dashboard-first software. A dashboard can make the loop visible, but the loop must not depend on the dashboard to exist.

SIBYL is not a shortcut around specification. It is a mechanism for making specification unavoidable.

## Architecture Boundary

The harness core and the web system are separate.

The Pi-based harness should be able to run independently: read a specification, execute a bounded work unit, emit state, pass through gates, and record what happened. It should remain useful from the command line, in automation, or inside another host process.

The planned web application, built with [Better T Stack](https://www.better-t-stack.dev), is an observer and control surface for execution state. It should show runs, gates, traces, decisions, and outcomes. It may start or steer work, but it should not be the source of truth for the harness.

This boundary matters because determinism comes from the execution contract, not from the interface wrapped around it.

## Status

SIBYL is in early design.

The implementation details will be developed through AEP rather than invented directly in this README. The expected path is:

```text
envision -> map -> design -> dispatch -> build -> reflect
```

This document should remain compact until the system earns more detail. The next durable artifacts should be specifications, contracts, run-state definitions, and verification gates produced by the AEP process.

---

## Stack & Local Development

The observer/control-surface web application is scaffolded with [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack) as a Turborepo monorepo.

- **TypeScript** — type safety across the monorepo
- **TanStack Start** — SSR framework with TanStack Router
- **TailwindCSS** + **shadcn/ui** — shared primitives in `packages/ui`
- **Hono** — lightweight server framework
- **oRPC** — end-to-end type-safe APIs with OpenAPI integration
- **Cloudflare Workers** — runtime
- **Drizzle** + **Cloudflare D1** (SQLite) — ORM and database
- **Better Auth** — authentication
- **Oxlint** + **Oxfmt** — linting & formatting
- **Starlight** — Astro docs site (`apps/docs`)
- **Turborepo** — monorepo build system

### Getting Started

Install dependencies:

```bash
bun install
```

Generate database migration files (Cloudflare D1 + Drizzle):

```bash
bun run db:generate
```

Start the development server:

```bash
bun run dev
```

Open [http://localhost:3001](http://localhost:3001) for the web app. The API runs at [http://localhost:3000](http://localhost:3000).

> Runtime database access uses the Cloudflare `DB` binding from `packages/infra/alchemy.run.ts`. A local `DATABASE_URL`, if present, is only for database tooling. Alchemy provisions D1 and applies migrations during `dev` and `deploy`.

### Project Structure

```
SIBYL/
├── apps/
│   ├── web/         # Frontend (React + TanStack Start)
│   ├── docs/        # Documentation site (Astro Starlight)
│   └── server/      # Backend API (Hono + oRPC)
├── packages/
│   ├── ui/          # Shared shadcn/ui components and styles
│   ├── api/         # API layer / business logic
│   ├── auth/        # Authentication configuration
│   ├── db/          # Database schema & queries
│   ├── env/         # Shared environment variables
│   └── infra/       # Alchemy / Cloudflare infrastructure
```

### Available Scripts

- `bun run dev` — start all applications in development mode
- `bun run dev:web` — start only the web application
- `bun run dev:server` — start only the server
- `bun run build` — build all applications
- `bun run check-types` — typecheck across all apps
- `bun run db:generate` — generate database client/types
- `bun run check` — run Oxlint and Oxfmt
- `bun run deploy` — deploy to Cloudflare via Alchemy
- `cd apps/docs && bun run dev` — start the documentation site

### Adding shared UI components

```bash
npx shadcn@latest add accordion dialog popover sheet table -c packages/ui
```

Import shared components:

```tsx
import { Button } from "@SIBYL/ui/components/button";
```
