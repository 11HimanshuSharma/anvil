#!/usr/bin/env node
/**
 * Calibrates the overlap threshold against labelled pairs.
 *
 * The 0.55 in entropy.ts was a guess, and an e2e test caught it missing
 * `triage_queue` vs `triage_reading_queue` - the exact fragmentation the
 * feature exists to prevent. This scores pairs that SHOULD and SHOULD NOT be
 * flagged so the number is chosen from evidence.
 */
import { waitFor, withPage } from './cdp.mjs';

const PAIRS = [
  // should flag: same job, different name
  ['YES', { name: 'triage_queue', title: 'Triage the reading queue', description: 'Applies my triage rules: archive stale unread items and strip tracking parameters from newsletter links.' },
           { name: 'triage_reading_queue', title: 'Triage reading queue', description: 'Applies the reading-queue triage rules: unread items older than a number of days become archived, and unread newsletter items have their tracking parameters stripped.' }],
  ['YES', { name: 'archive_stale_links', title: 'Archive stale links', description: 'Archives saved links that are still unread and older than a given number of days, so the queue only holds things I might actually read.' },
           { name: 'archive_old_links', title: 'Archive old links', description: 'Archives saved links that are unread and older than a number of days, so the queue only keeps things I might read.' }],
  ['YES', { name: 'normalize_source', title: 'Normalize source', description: 'Rewrites the source field of each saved link to the real domain name.' },
           { name: 'clean_source_name', title: 'Clean source name', description: 'Cleans up the source field on saved links so it holds the real domain.' }],
  // should NOT flag: genuinely different jobs
  ['NO',  { name: 'triage_queue', title: 'Triage the reading queue', description: 'Applies my triage rules: archive stale unread items and strip tracking parameters from newsletter links.' },
           { name: 'count_by_source', title: 'Count items by source', description: 'Counts saved links grouped by their source, so I can see where my queue comes from.' }],
  ['NO',  { name: 'find_near_duplicates', title: 'Find near duplicates', description: 'Compares titles and URLs across saved links and returns pairs that look like the same thing saved twice.' },
           { name: 'archive_stale_links', title: 'Archive stale links', description: 'Archives saved links that are still unread and older than a given number of days.' }],
  ['NO',  { name: 'export_bibtex', title: 'Export BibTeX', description: 'Produces a BibTeX entry for each saved link that points at an academic paper.' },
           { name: 'triage_queue', title: 'Triage the reading queue', description: 'Applies my triage rules: archive stale unread items and strip tracking parameters from newsletter links.' }],
];

await withPage(process.argv[2] ?? 'http://localhost:5173/', async ({ evaluate }) => {
  await waitFor(evaluate, 'Boolean(window.anvil?.entropy)', { label: 'app boot' });
  const scored = [];
  for (const [label, a, b] of PAIRS) {
    const score = await evaluate(
      `window.anvil.entropy.similarity(${JSON.stringify(a)}, ${JSON.stringify(b)})`,
    );
    scored.push({ label, pair: `${a.name} / ${b.name}`, score });
    console.log(`${label.padEnd(4)} ${score.toFixed(3)}  ${a.name} / ${b.name}`);
  }
  const yes = scored.filter((s) => s.label === 'YES').map((s) => s.score);
  const no = scored.filter((s) => s.label === 'NO').map((s) => s.score);
  console.log(`\nshould-flag range     ${Math.min(...yes).toFixed(3)} .. ${Math.max(...yes).toFixed(3)}`);
  console.log(`should-not-flag range ${Math.min(...no).toFixed(3)} .. ${Math.max(...no).toFixed(3)}`);
  const gap = Math.min(...yes) - Math.max(...no);
  console.log(`separation            ${gap.toFixed(3)}  ->  threshold ${((Math.min(...yes) + Math.max(...no)) / 2).toFixed(2)}`);

  const threshold = await evaluate('window.anvil.entropy.threshold');
  const misses = scored.filter((s) => (s.label === 'YES') !== (s.score >= threshold));
  console.log(`
threshold in use      ${threshold}`);
  if (misses.length > 0) {
    for (const miss of misses) {
      console.error(`MISCLASSIFIED ${miss.label} ${miss.score.toFixed(3)} ${miss.pair}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`all ${scored.length} labelled pairs classified correctly`);
  }
});
