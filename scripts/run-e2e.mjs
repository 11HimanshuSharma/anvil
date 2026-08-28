#!/usr/bin/env node
/**
 * End-to-end test of the loop that IS the submission:
 *
 *   agent calls propose_tool  ->  drawer opens with a real dry run
 *   ->  human clicks Approve  ->  tool is registered live, no reload
 *   ->  agent calls it by name and gets a deterministic answer
 *
 * Everything the agent does goes through modelContext.executeTool, the same
 * path ChatGPT uses. The approval is a real DOM click on the real button.
 *
 *   node scripts/run-e2e.mjs [baseUrl]
 */

import { waitFor, withPage } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://localhost:5173/';

// The hero tool, written the way an agent would write it.
const DRAFT = {
  name: 'triage_queue',
  title: 'Triage the reading queue',
  description:
    'Applies the reading-queue triage rules: anything unread and older than the given number of days becomes archived, and anything unread from a newsletter has its tracking parameters stripped. Returns the list of changes it made.',
  inputSchema: {
    type: 'object',
    properties: {
      staleDays: { type: 'number', description: 'Unread items older than this are archived.' },
    },
    additionalProperties: false,
  },
  code: `
    const staleDays = typeof args.staleDays === 'number' ? args.staleDays : 60;
    const cutoff = Date.now() - staleDays * 86400000;
    const items = await host.items.list({ status: 'unread', limit: 200 });
    const changes = [];
    for (const item of items) {
      const added = Date.parse(item.addedAt ?? 0) || item.addedAt || 0;
      if (item.source === 'newsletter' && item.url.includes('utm_')) {
        const url = new URL(item.url);
        for (const key of [...url.searchParams.keys()]) {
          if (key.startsWith('utm_')) url.searchParams.delete(key);
        }
        await host.items.upsert({ id: item.id, url: url.toString(), source: url.hostname.replace(/^www\\./, '') });
        changes.push({ id: item.id, change: 'cleaned tracking parameters' });
      } else if (added && added < cutoff) {
        await host.items.upsert({ id: item.id, status: 'archived' });
        changes.push({ id: item.id, change: 'archived as stale' });
      }
    }
    return { changed: changes.length, changes };
  `,
  capabilities: ['read:items', 'write:items'],
  rationale: 'I keep re-deriving these triage rules from prose, and I get them slightly different every time.',
  testCases: [{ args: { staleDays: 60 }, expectation: 'archives stale unread items and cleans newsletter URLs' }],
};

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name.padEnd(34)} ${detail}`);
}

await withPage(BASE, async ({ evaluate, run }) => {
  await waitFor(evaluate, "Boolean(window.anvil?.mc)", { label: 'app boot' });
  await waitFor(
    evaluate,
    "(await window.anvil.mc.getTools()).some(t => t.name === 'propose_tool')",
    { label: 'meta tools registered' },
  );

  const before = await evaluate('(await window.anvil.mc.getTools()).length');
  check('builtins + meta registered', before === 8, `${before} tools (expected 8)`);

  // 1. The agent proposes.
  const proposal = await evaluate(
    `window.anvil.mc.executeTool('propose_tool', ${JSON.stringify(DRAFT)})`,
  );
  check('propose_tool accepted', proposal?.ok === true, JSON.stringify(proposal?.status ?? proposal));
  check(
    'propose_tool did NOT register',
    proposal?.registered === false &&
      (await evaluate("(await window.anvil.mc.getTools()).some(t => t.name === 'triage_queue')")) === false,
    'tool is not callable while pending',
  );

  const dryRun = proposal?.dryRuns?.[0];
  check('draft dry-ran on real data', dryRun?.ok === true, JSON.stringify(dryRun ?? 'none'));

  // 2. The dry run must not have touched the database.
  const unreadAfterDryRun = await evaluate(
    "(await window.anvil.mc.executeTool('list_items', { status: 'unread', limit: 200 })).total",
  );
  check('dry run wrote nothing', unreadAfterDryRun === 18, `${unreadAfterDryRun} unread (expected 18)`);

  // 3. The drawer is open with the review UI.
  await waitFor(evaluate, "document.getElementById('drawer').dataset.open === 'true'", {
    label: 'drawer opens',
  });
  const caps = await evaluate("[...document.querySelectorAll('#drawer .cap')].map(e => e.textContent).join(' | ')");
  check('capability chips shown', caps.includes('reads') && caps.includes('writes'), caps);
  const hasDiff = await evaluate("document.querySelectorAll('#drawer .dryrun').length > 0");
  check('dry-run output shown', hasDiff === true, 'drawer renders what it did');
  const editable = await evaluate("Boolean(document.querySelector('#drawer .drawer-description'))");
  check('description is editable', editable === true, 'human owns the prose');

  // 4. The human edits the description and approves.
  await run(`
    const field = document.querySelector('#drawer .drawer-description');
    field.value = 'Applies my triage rules: archive stale unread items and strip tracking parameters from newsletter links.';
    [...document.querySelectorAll('#drawer button')].find(b => b.textContent.startsWith('Approve')).click();
  `);
  await waitFor(evaluate, "document.getElementById('drawer').dataset.open === 'false'", {
    label: 'drawer closes after approval',
  });

  // 5. Registered live, in the same session, with no reload.
  await waitFor(
    evaluate,
    "(await window.anvil.mc.getTools()).some(t => t.name === 'triage_queue')",
    { label: 'tool appears in getTools()' },
  );
  const after = await evaluate('(await window.anvil.mc.getTools()).length');
  check('registered without a reload', after === before + 1, `${before} -> ${after} tools`);

  const annotations = await evaluate(
    "JSON.stringify((await window.anvil.mc.getTools()).find(t => t.name === 'triage_queue').annotations)",
  );
  check(
    'annotated as untrusted + write',
    annotations.includes('"untrustedContentHint":true') && annotations.includes('"readOnlyHint":false'),
    annotations,
  );

  const humanDescription = await evaluate(
    "(await window.anvil.mc.getTools()).find(t => t.name === 'triage_queue').description",
  );
  check(
    'the accepted wording is what ships',
    humanDescription.startsWith('Applies my triage rules'),
    humanDescription.slice(0, 48) + '…',
  );

  // 6. The agent calls it. Twice: same input, same output.
  const first = await evaluate("window.anvil.mc.executeTool('triage_queue', { staleDays: 60 })");
  check('agent can call it', typeof first?.changed === 'number', JSON.stringify(first?.changed ?? first));

  const unreadAfterLive = await evaluate(
    "(await window.anvil.mc.executeTool('list_items', { status: 'unread', limit: 200 })).total",
  );
  check('live run actually wrote', unreadAfterLive < 18, `${unreadAfterLive} unread (was 18)`);

  const second = await evaluate("window.anvil.mc.executeTool('triage_queue', { staleDays: 60 })");
  check(
    'idempotent on a settled queue',
    second?.changed === 0,
    `second run changed ${second?.changed} (the point: same input, same output)`,
  );

  // 7. It is in the audit log, and it survives a reload.
  const audited = await evaluate("document.body.innerText.includes('triage_queue')");
  check('appears in the audit log', audited === true, 'every invocation is recorded');

  await evaluate('location.reload()');
  await waitFor(evaluate, "Boolean(window.anvil?.mc)", { label: 'reboot' });
  await waitFor(
    evaluate,
    "(await window.anvil.mc.getTools()).some(t => t.name === 'triage_queue')",
    { label: 'tool restored after reload' },
  );
  check('survives a reload', true, 're-registered from IndexedDB on boot');
});

const passed = results.filter((result) => result.pass).length;
console.log(`\nSUMMARY:: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
