#!/usr/bin/env bun
/**
 * SIBYL-008: the `sibyl` bin — a thin runnable shim over {@link runCli}.
 *
 * Run directly with Bun (no build step; the harness runs TypeScript natively):
 *
 *   bun apps/harness/src/cli.ts --version
 *   bun apps/harness/src/cli.ts originate --product P --problem Q --vision V --yes --cwd "$DIR"
 *   bun apps/harness/src/cli.ts decisions ls --cwd "$DIR"
 */

import { runCli } from "./main";

const code = await runCli(process.argv.slice(2));
process.exit(code);
