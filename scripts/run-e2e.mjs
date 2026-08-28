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
  // Registration is sequential, so wait for the LAST tool rather than any one
  // of them: snapshotting mid-loop was a flaky test, not a flaky app.
  await waitFor(
    evaluate,
    "(await window.anvil.mc.getTools()).some(t => t.name === 'dry_run_draft')",
    { label: 'all built-in and meta tools registered' },
  );

  const before = await evaluate('(await window.anvil.mc.getTools()).length');
  check('builtins + meta registered', before === 8, `${before} tools (expected 8)`);

  // Spec conformance. These exist because an earlier shim invented
  // executeTool(name, argsObject) -> object, so every in-page call passed
  // locally and would have thrown in Chrome and ChatGPT. The shim must model
  // the real contract or it stops being a test of what ships.
  const specShape = await run(`
    const tools = await window.anvil.mc.getTools();
    const tool = tools.find(t => t.name === 'list_items');
    const out = {};
    // executeTool takes the RegisteredTool, not a name.
    try { await window.anvil.mc.executeTool('list_items', {}); out.nameRejected = false; }
    catch (e) { out.nameRejected = e instanceof TypeError; }
    // ...and resolves with a JSON string.
    const raw = await window.anvil.mc.executeTool(tool, { limit: 1 });
    out.returnsString = typeof raw === 'string';
    out.parses = (() => { try { return Array.isArray(JSON.parse(raw).items); } catch { return false; } })();
    // registerTool resolves on success rather than staying pending.
    const ac = new AbortController();
    const started = Date.now();
    await window.anvil.mc.registerTool(
      { name: 'spec_probe', description: 'Conformance probe.', inputSchema: { type: 'object' }, execute: async () => 'ok' },
      { signal: ac.signal },
    );
    out.registerResolved = Date.now() - started < 2000;
    ac.abort();
    return out;
  `);
  check('executeTool refuses a bare tool name', specShape.nameRejected === true, 'TypeError as the IDL requires');
  check('executeTool resolves with a JSON string', specShape.returnsString && specShape.parses, 'DOMString, parses');
  check('registerTool resolves on success', specShape.registerResolved === true, 'does not hang');

  // 0. The cold-open path: a visitor with no agent attached can still see the
  // loop, because the demo button goes through the real propose_tool.
  await run("document.querySelector('#demo .demo-button').click();");
  await waitFor(evaluate, "document.getElementById('drawer').dataset.open === 'true'", {
    label: 'demo proposal opens the drawer',
  });
  const demoName = await evaluate("document.querySelector('#drawer .drawer-name').textContent");
  check('cold-open demo works without an agent', demoName === 'triage_queue', demoName);
  await run("[...document.querySelectorAll('#drawer button')].find(b => b.textContent === 'Reject').click();");
  await waitFor(evaluate, "document.getElementById('drawer').dataset.open === 'false'", {
    label: 'rejected proposal closes',
  });

  // 1. The agent proposes.
  const proposal = await evaluate(
    `window.anvil.callTool('propose_tool', ${JSON.stringify(DRAFT)})`,
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
    "(await window.anvil.callTool('list_items', { status: 'unread', limit: 200 })).total",
  );
  check('dry run wrote nothing', unreadAfterDryRun === 18, `${unreadAfterDryRun} unread (expected 18)`);

  // 3. The drawer is open with the review UI.
  await waitFor(evaluate, "document.getElementById('drawer').dataset.open === 'true'", {
    label: 'drawer opens',
  });
  const caps = await evaluate("[...document.querySelectorAll('#drawer .cap')].map(e => e.textContent).join(' | ')");
  check('capability chips shown', caps.includes('reads') && caps.includes('writes'), caps);
  const diffRows = await evaluate("document.querySelectorAll('#drawer .diff-row').length");
  const diffText = await evaluate(
    "[...document.querySelectorAll('#drawer .diff-change')].slice(0,1).map(e => e.textContent).join('')",
  );
  check(
    'before/after diff rendered',
    diffRows > 0 && diffText.includes('→'),
    `${diffRows} changed rows, e.g. ${diffText.slice(0, 60)}`,
  );
  const editable = await evaluate("Boolean(document.querySelector('#drawer .drawer-description'))");
  check('description is editable', editable === true, 'human owns the prose');

  // 3a. A second proposal arriving mid-review must not hijack the drawer.
  await evaluate(
    `window.anvil.callTool('propose_tool', ${JSON.stringify({
      name: 'queued_probe',
      title: 'Queued probe',
      description: 'A second proposal used to check that it queues instead of stealing the drawer.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      code: 'return 1;',
      capabilities: [],
      rationale: 'Queueing check.',
      testCases: [],
    })})`,
  );
  const stillShowing = await evaluate("document.querySelector('#drawer .drawer-name').textContent");
  const queuedLine = await evaluate(
    "document.querySelector('#drawer .drawer-queued')?.textContent ?? ''",
  );
  check(
    'a new proposal queues instead of hijacking',
    stillShowing === 'triage_queue' && queuedLine.includes('1 more proposal'),
    `${stillShowing} / ${queuedLine}`,
  );

  // 3b. An in-progress edit must survive a re-render. "Run again" writes to the
  // proposal, which re-renders the drawer; losing the wording there would be
  // the worst possible place for a data-loss bug.
  await run(`
    const field = document.querySelector('#drawer .drawer-description');
    field.value = 'EDIT-SURVIVES-RERENDER';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('#drawer button')].find(b => b.textContent === 'run again').click();
  `);
  await waitFor(
    evaluate,
    "document.querySelectorAll('#drawer .dryrun').length >= 2",
    { label: 'second dry run lands' },
  );
  const preserved = await evaluate("document.querySelector('#drawer .drawer-description').value");
  check('edits survive a re-render', preserved === 'EDIT-SURVIVES-RERENDER', preserved.slice(0, 40));

  // 4. The human edits the description and approves.
  await run(`
    const field = document.querySelector('#drawer .drawer-description');
    field.value = 'Applies my triage rules: archive stale unread items and strip tracking parameters from newsletter links.';
    [...document.querySelectorAll('#drawer button')].find(b => b.textContent.startsWith('Approve')).click();
  `);
  // Approving reveals the queued proposal rather than closing on it.
  await waitFor(evaluate, "document.querySelector('#drawer .drawer-name')?.textContent === 'queued_probe'", {
    label: 'queued proposal is revealed after approval',
  });
  check('queued proposal revealed after approval', true, 'resolving one shows the next');
  await run("[...document.querySelectorAll('#drawer button')].find(b => b.textContent === 'Reject').click();");
  await waitFor(evaluate, "document.getElementById('drawer').dataset.open === 'false'", {
    label: 'drawer closes once the queue empties',
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
  const first = await evaluate("window.anvil.callTool('triage_queue', { staleDays: 60 })");
  check('agent can call it', typeof first?.changed === 'number', JSON.stringify(first?.changed ?? first));

  const unreadAfterLive = await evaluate(
    "(await window.anvil.callTool('list_items', { status: 'unread', limit: 200 })).total",
  );
  check('live run actually wrote', unreadAfterLive < 18, `${unreadAfterLive} unread (was 18)`);

  const second = await evaluate("window.anvil.callTool('triage_queue', { staleDays: 60 })");
  check(
    'idempotent on a settled queue',
    second?.changed === 0,
    `second run changed ${second?.changed} (the point: same input, same output)`,
  );

  // 7. It is in the audit log, and it survives a reload.
  const audited = await evaluate("document.body.innerText.includes('triage_queue')");
  check('appears in the audit log', audited === true, 'every invocation is recorded');

  // 8. Proposing a name that now exists is refused, and Escape closes a drawer.
  const duplicate = await evaluate(
    `window.anvil.callTool('propose_tool', ${JSON.stringify({ ...DRAFT, testCases: [] })})`,
  );
  check(
    'duplicate name refused',
    duplicate?.ok === false && duplicate?.error === 'name_taken',
    String(duplicate?.error ?? duplicate?.ok),
  );

  const readOnlyProposal = await evaluate(
    `window.anvil.callTool('propose_tool', ${JSON.stringify({
      name: 'count_by_source',
      title: 'Count items by source',
      description: 'Counts saved links grouped by their source, so I can see where my queue comes from.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      code: [
        'const items = await host.items.list({ limit: 200 });',
        'const counts = {};',
        'for (const item of items) counts[item.source] = (counts[item.source] ?? 0) + 1;',
        'return counts;',
      ].join('\n'),
      capabilities: ['read:items'],
      rationale: 'I ask for this breakdown constantly.',
      testCases: [{ args: {}, expectation: 'a map of source to count' }],
    })})`,
  );
  check(
    'second proposal accepted',
    readOnlyProposal?.ok === true,
    String(readOnlyProposal?.status ?? readOnlyProposal?.error),
  );
  await waitFor(evaluate, "document.getElementById('drawer').dataset.open === 'true'", {
    label: 'drawer reopens',
  });
  const readOnlyDiff = await evaluate(
    "document.querySelectorAll('#drawer .diff-none').length > 0",
  );
  check('read-only tool shows it changed nothing', readOnlyDiff === true, 'diff says read-only');
  await run("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));");
  const closedByEscape = await evaluate("document.getElementById('drawer').dataset.open === 'false'");
  check('Escape closes the drawer', closedByEscape === true, 'keyboard dismissal works');

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
