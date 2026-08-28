#!/usr/bin/env node
/**
 * Measures the determinism half of Anvil's central claim.
 *
 * The claim is that a frozen tool gives the same answer every time, while the
 * same procedure re-derived from prose does not. This script measures the
 * FIRST arm automatically and honestly: it reseeds the workspace to an
 * identical starting state, runs the registered tool, and compares the exact
 * output across N trials.
 *
 * The second arm - asking an agent to perform the same procedure from prose,
 * in a fresh chat, N times - needs a live agent and cannot be automated here.
 * Run it by hand and paste the results into the table this prints. Reporting
 * only the arm that flatters the project would make the number worthless.
 *
 *   node scripts/measure-variance.mjs [trials] [baseUrl]
 */

import { createHash } from 'node:crypto';
import { waitFor, withPage } from './cdp.mjs';

const TRIALS = Number(process.argv[2] ?? 10);
const BASE = process.argv[3] ?? 'http://localhost:5173/';

const DRAFT = {
  name: 'triage_queue',
  title: 'Triage the reading queue',
  description:
    'Applies my reading-queue triage rules: unread newsletter items get tracking parameters stripped, ' +
    'and unread items older than staleDays are archived.',
  inputSchema: {
    type: 'object',
    properties: { staleDays: { type: 'number' } },
    additionalProperties: false,
  },
  code: [
    "const staleDays = typeof args.staleDays === 'number' ? args.staleDays : 60;",
    'const cutoff = Date.now() - staleDays * 86400000;',
    "const items = await host.items.list({ status: 'unread', limit: 200 });",
    'const changes = [];',
    'for (const item of items) {',
    "  if (item.source === 'newsletter' && item.url.includes('utm_')) {",
    '    const url = new URL(item.url);',
    "    for (const key of [...url.searchParams.keys()]) if (key.startsWith('utm_')) url.searchParams.delete(key);",
    '    await host.items.upsert({ id: item.id, url: url.toString(), source: url.hostname });',
    "    changes.push(item.id + ':cleaned');",
    '  } else if (Date.parse(item.addedAt) < cutoff) {',
    "    await host.items.upsert({ id: item.id, status: 'archived' });",
    "    changes.push(item.id + ':archived');",
    '  }',
    '}',
    'return { changed: changes.length, changes: changes.sort() };',
  ].join('\n'),
  capabilities: ['read:items', 'write:items'],
  rationale: 'Variance measurement fixture.',
  testCases: [],
};

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);

await withPage(BASE, async ({ evaluate, run }) => {
  await waitFor(evaluate, 'Boolean(window.anvil?.mc)', { label: 'app boot' });
  await waitFor(evaluate, "(await window.anvil.mc.getTools()).some(t => t.name === 'dry_run_draft')", {
    label: 'tools registered',
  });

  const already = await evaluate(
    "(await window.anvil.mc.getTools()).some(t => t.name === 'triage_queue')",
  );
  if (!already) {
    await evaluate(`window.anvil.mc.executeTool('propose_tool', ${JSON.stringify(DRAFT)})`);
    await waitFor(evaluate, "document.getElementById('drawer').dataset.open === 'true'", {
      label: 'drawer opens',
    });
    await run(
      "[...document.querySelectorAll('#drawer button')].find(b => b.textContent.startsWith('Approve')).click();",
    );
    await waitFor(evaluate, "(await window.anvil.mc.getTools()).some(t => t.name === 'triage_queue')", {
      label: 'tool registered',
    });
  }

  const outcomes = [];
  const durations = [];
  for (let trial = 0; trial < TRIALS; trial += 1) {
    // Identical starting state for every trial. Without this we would be
    // measuring the queue draining, not the tool's determinism.
    await evaluate('window.anvil.reseed()');
    const started = Date.now();
    const result = await evaluate("window.anvil.mc.executeTool('triage_queue', { staleDays: 60 })");
    durations.push(Date.now() - started);
    outcomes.push(hash(result));
  }

  const distinct = new Set(outcomes);
  const modal = [...distinct]
    .map((digest) => ({ digest, count: outcomes.filter((entry) => entry === digest).length }))
    .sort((a, b) => b.count - a.count)[0];

  const mean = Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);

  console.log(`\nWITH THE TOOL — ${TRIALS} trials, workspace reseeded before each\n`);
  console.log(`  identical results   ${modal.count}/${TRIALS}`);
  console.log(`  distinct outputs    ${distinct.size}`);
  console.log(`  mean wall clock     ${mean}ms`);
  console.log(`  output digest       ${modal.digest}`);
  console.log(`
WITHOUT THE TOOL — not automatable, run by hand
  Open the deployed URL in ChatGPT's browser. In ${TRIALS} FRESH chats, paste exactly:

    "Triage my reading queue: for anything unread from a newsletter, strip the
     tracking parameters from the URL and set the source to the real domain;
     archive anything unread that is older than 60 days. Tell me what you changed."

  Reset the workspace between runs with the "reset items" button. Record the set
  of changed item ids each time, and report the identical-result rate the same way.
  If the numbers are unflattering, publish them anyway.
`);

  if (distinct.size !== 1) {
    console.error(`WARNING: the tool arm was NOT deterministic (${distinct.size} distinct outputs).`);
    process.exitCode = 1;
  }
});
