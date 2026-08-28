#!/usr/bin/env node
/**
 * Runs the end-to-end suite against Chrome's REAL WebMCP implementation
 * instead of the local shim.
 *
 * `chrome://flags/#enable-webmcp-testing` corresponds to the `WebMCP` feature,
 * which can be switched on from the command line - so the contract can be
 * verified locally, before any deploy, against the implementation that
 * actually ships. A shim can only ever prove you agree with yourself.
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['scripts/run-e2e.mjs', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, CHROME_ARGS: '--enable-features=WebMCP' },
});
process.exit(result.status ?? 1);
