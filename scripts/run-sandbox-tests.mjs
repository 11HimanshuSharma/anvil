#!/usr/bin/env node
/**
 * Runs the sandbox containment suite in a real headless Chrome and reports the
 * result as a process exit code, so it can gate a build.
 *
 * `--dump-dom` is not enough: the suite is asynchronous and the watchdog case
 * deliberately takes three seconds, so we drive the page over the DevTools
 * protocol and poll until it reports a summary.
 *
 *   node scripts/run-sandbox-tests.mjs [url]
 *
 * The sandboxed iframe needs a browser that executes scripts in a src-loaded
 * sandbox="allow-scripts" frame. Real Chrome does. Some embedded preview panes
 * do not, and there every case fails at boot - that is the harness, not the app.
 */

import { waitFor, withPage } from './cdp.mjs';

const URL_UNDER_TEST = process.argv[2] ?? 'http://localhost:5173/sandbox-tests.html';

const exitCode = await withPage(URL_UNDER_TEST, async ({ evaluate }) => {
  await waitFor(
    evaluate,
    "document.getElementById('summary')?.textContent.startsWith('SUMMARY')",
    { timeoutMs: 90_000, label: 'suite to finish' },
  );

  const report = await evaluate(`[...document.querySelectorAll('.case')].map(el =>
    (el.dataset.pass === 'true' ? 'PASS ' : 'FAIL ') +
    el.querySelector('.case-name').textContent.padEnd(28) +
    el.querySelector('.case-claim').textContent + '\\n       ' +
    el.querySelector('.case-detail').textContent
  ).join('\\n')`);

  const summary = await evaluate("document.getElementById('summary').textContent");
  const ok = await evaluate("document.getElementById('summary').dataset.ok === 'true'");

  console.log(report);
  console.log(`\n${summary}`);
  return ok ? 0 : 1;
}).catch((error) => {
  console.error(`sandbox tests failed to run: ${error.message}`);
  return 2;
});

process.exit(exitCode);
