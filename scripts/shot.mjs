#!/usr/bin/env node
/** Captures stills of the workspace and the review drawer, for the README. */
import { waitFor, withPage } from './cdp.mjs';

const DRAFT = {
  name: 'triage_queue',
  title: 'Triage the reading queue',
  description:
    'Applies the reading-queue triage rules: anything unread and older than the given number of days becomes archived, and anything unread from a newsletter has its tracking parameters stripped. Returns the list of changes it made.',
  inputSchema: { type: 'object', properties: { staleDays: { type: 'number' } }, additionalProperties: false },
  code: "const items = await host.items.list({ status: 'unread', limit: 200 });\nconst changes = [];\nfor (const item of items) {\n  if (item.source === 'newsletter' && item.url.includes('utm_')) {\n    const url = new URL(item.url);\n    for (const key of [...url.searchParams.keys()]) if (key.startsWith('utm_')) url.searchParams.delete(key);\n    await host.items.upsert({ id: item.id, url: url.toString(), source: url.hostname });\n    changes.push({ id: item.id, change: 'cleaned tracking parameters' });\n  }\n}\nreturn { changed: changes.length, changes };",
  capabilities: ['read:items', 'write:items'],
  rationale: 'I keep re-deriving these triage rules from prose, and I get them slightly different every time.',
  testCases: [{ args: { staleDays: 60 }, expectation: 'cleans newsletter URLs' }],
};

await withPage(process.argv[2] ?? 'http://localhost:5173/', async ({ evaluate, screenshot }) => {
  await waitFor(evaluate, 'Boolean(window.anvil?.mc)');
  await waitFor(evaluate, "(await window.anvil.mc.getTools()).some(t => t.name === 'propose_tool')");
  console.log(await screenshot('docs/workspace.png'));
  await evaluate(`window.anvil.mc.executeTool('propose_tool', ${JSON.stringify(DRAFT)})`);
  await waitFor(evaluate, "document.getElementById('drawer').dataset.open === 'true'");
  // The drawer slides in over 220ms; screenshotting immediately catches it mid-transform.
  await evaluate("new Promise(r => setTimeout(r, 500))");
  const box = await evaluate("JSON.stringify(document.getElementById('drawer').getBoundingClientRect())");
  console.log('drawer rect', box, 'viewport', await evaluate('innerWidth'));
  console.log(await screenshot('docs/drawer.png'));
});
