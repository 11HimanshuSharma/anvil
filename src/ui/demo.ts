import { mc } from '../webmcp/context';
import { h, mount } from './dom';

/**
 * The cold-open path.
 *
 * A judge or a first-time visitor without a WebMCP-capable agent attached sees
 * a reading queue and a list of tool names, and none of the actual idea. This
 * button submits a realistic draft through the *real* `propose_tool` — same
 * code path, same sandbox, same dry run, same drawer — so the loop can be seen
 * and approved without an agent in the room.
 *
 * It is labelled as a stand-in rather than dressed up as the agent, because a
 * demo that pretends is worth less than one that explains.
 */

const DEMO_DRAFT = {
  name: 'triage_queue',
  title: 'Triage the reading queue',
  description:
    'Applies my reading-queue triage rules: unread items from a newsletter get their tracking ' +
    'parameters stripped and their source set to the real domain, and unread items older than ' +
    'staleDays are archived. Returns the list of changes made.',
  inputSchema: {
    type: 'object',
    properties: {
      staleDays: {
        type: 'number',
        description: 'Unread items older than this many days are archived. Defaults to 60.',
      },
    },
    additionalProperties: false,
  },
  code: `const staleDays = typeof args.staleDays === 'number' ? args.staleDays : 60;
const cutoff = Date.now() - staleDays * 86400000;
const items = await host.items.list({ status: 'unread', limit: 200 });
const changes = [];

for (const item of items) {
  if (item.source === 'newsletter' && item.url.includes('utm_')) {
    const url = new URL(item.url);
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith('utm_')) url.searchParams.delete(key);
    }
    await host.items.upsert({
      id: item.id,
      url: url.toString(),
      source: url.hostname.replace(/^www\\./, ''),
    });
    changes.push({ id: item.id, change: 'cleaned tracking parameters' });
  } else if (Date.parse(item.addedAt) < cutoff) {
    await host.items.upsert({ id: item.id, status: 'archived' });
    changes.push({ id: item.id, change: 'archived as stale' });
  }
}

return { changed: changes.length, changes };`,
  capabilities: ['read:items', 'write:items'],
  networkDomains: [],
  rationale:
    'I re-explain these triage rules every session and get a slightly different result each time. ' +
    'Frozen as a tool, it is the same answer every time.',
  testCases: [
    { args: { staleDays: 60 }, expectation: 'cleans newsletter URLs and archives stale unread items' },
  ],
};

export function mountDemoButton(target: HTMLElement): void {
  const status = h('p', { class: 'demo-status' });

  const button = h(
    'button',
    {
      class: 'primary demo-button',
      on: {
        click: (_event, element) => {
          element.disabled = true;
          status.textContent = 'Running the draft against your real items…';
          void mc
            .executeTool('propose_tool', DEMO_DRAFT as unknown as Record<string, unknown>)
            .then((result) => {
              const failed =
                typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false;
              status.textContent = failed
                ? `Could not propose: ${String((result as { detail?: unknown }).detail ?? 'unknown error')}`
                : 'Proposal is open for review on the right.';
            })
            .catch((error: unknown) => {
              status.textContent = error instanceof Error ? error.message : String(error);
            })
            .finally(() => {
              element.disabled = false;
            });
        },
      },
    },
    'Propose a tool',
  );

  mount(
    target,
    h('p', {
      class: 'hint',
      text:
        'No agent attached? This submits a realistic draft through the same propose_tool your agent ' +
        'would call — same sandbox, same dry run, same review. Only the author differs.',
    }),
    button,
    status,
  );
}
