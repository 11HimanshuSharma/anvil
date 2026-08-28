import { archiveTool, listTools, onToolsChanged } from '../store/tools';
import type { ToolDef } from '../store/types';
import {
  contextCost,
  retirementCandidates,
  RETIREMENT_WINDOW_MS,
} from '../surface/entropy';
import { binding, mc, MODE_LABEL } from '../webmcp/context';
import type { ToolRegistry } from '../webmcp/registry';
import type { ToolDescriptor } from '../webmcp/types';
import { h, mount, relativeDays } from './dom';

/**
 * Mirrors exactly what the agent currently sees, re-read on every `toolchange`.
 *
 * This is the visible half of "tool surface entropy" (build plan §3.7): every
 * tool you keep is context your agent carries into every future turn, and
 * Chrome's own guidance warns that overlapping tools make an agent worse at
 * choosing between them. A surface that grows by accretion gets worse as the
 * user invests in it, so the panel shows the cost, the usage, and which tools
 * have stopped earning their keep.
 */

let container: HTMLElement | null = null;
let registry: ToolRegistry | null = null;
let queue: Promise<void> = Promise.resolve();

/**
 * `?retire=<days>` shortens the retirement window.
 *
 * Without it the chip is unreachable in any demo or test, because nothing is
 * ever fourteen days old - which is precisely why this feature sat computed
 * but unshipped. It changes when a *suggestion* appears; retiring is still a
 * click, so there is nothing to abuse.
 */
function retirementWindow(): number {
  try {
    const raw = new URLSearchParams(location.search).get('retire');
    if (raw === null) return RETIREMENT_WINDOW_MS;
    const days = Number(raw);
    return Number.isFinite(days) && days >= 0 ? days * 86_400_000 : RETIREMENT_WINDOW_MS;
  } catch {
    return RETIREMENT_WINDOW_MS;
  }
}

export function mountSurfacePanel(target: HTMLElement, toolRegistry: ToolRegistry): void {
  container = target;
  registry = toolRegistry;
  mc.addEventListener('toolchange', () => void render());
  onToolsChanged(() => void render());
  void render();
}

export function render(): Promise<void> {
  queue = queue.then(async () => {
    if (!container) return;

    let tools: readonly ToolDescriptor[];
    try {
      tools = await mc.getTools();
    } catch (error) {
      mount(container, h('p', { class: 'empty', text: `getTools() failed: ${String(error)}` }));
      return;
    }

    const custom = await listTools();
    const byName = new Map(custom.map((def) => [def.name, def]));
    const retiring = new Set(
      retirementCandidates(custom, Date.now(), retirementWindow()).map((def) => def.name),
    );

    const totalCost = tools.reduce((sum, tool) => sum + contextCost(tool), 0);
    const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true).length;

    mount(
      container,
      h(
        'div',
        { class: 'surface-head' },
        h('div', { class: 'badge', data: { mode: binding.mode }, text: MODE_LABEL[binding.mode] }),
        h(
          'div',
          { class: 'surface-stats' },
          h('strong', { text: String(tools.length) }),
          ` tool${tools.length === 1 ? '' : 's'} · `,
          h('strong', { text: `~${totalCost.toLocaleString('en-US')}` }),
          ' tokens of definitions · ',
          `${readOnly} read, ${tools.length - readOnly} write`,
        ),
      ),
      tools.length === 0
        ? h('p', { class: 'empty', text: 'No tools registered.' })
        : h(
            'ul',
            { class: 'surface-tools' },
            ...tools.map((tool) => renderTool(tool, byName.get(tool.name), retiring.has(tool.name))),
          ),
    );
  });
  return queue;
}

function renderTool(
  tool: ToolDescriptor,
  def: ToolDef | undefined,
  retirementCandidate: boolean,
): HTMLElement {
  return h(
    'li',
    { class: 'surface-tool', data: { retire: String(retirementCandidate) } },
    h(
      'details',
      {},
      h(
        'summary',
        {},
        h('span', { class: 'surface-name', text: tool.name }),
        tool.annotations?.readOnlyHint === true ? h('span', { class: 'tag ok', text: 'read' }) : null,
        tool.annotations?.untrustedContentHint === true
          ? h('span', { class: 'tag warn', text: 'yours' })
          : null,
        h('span', { class: 'surface-cost', text: `~${contextCost(tool)}t` }),
      ),
      h('p', { class: 'surface-desc', text: tool.description }),
      def ? renderUsage(def, retirementCandidate) : null,
    ),
  );
}

function renderUsage(def: ToolDef, retirementCandidate: boolean): HTMLElement {
  const used =
    def.stats.calls === 0
      ? 'never called'
      : `${def.stats.calls} call${def.stats.calls === 1 ? '' : 's'}${
          def.stats.lastUsedAt ? `, last ${relativeDays(def.stats.lastUsedAt)}` : ''
        }`;

  return h(
    'div',
    { class: 'surface-usage' },
    h('span', { class: 'surface-used', text: used }),
    def.stats.errors > 0
      ? h('span', { class: 'surface-errors', text: `${def.stats.errors} failed` })
      : null,
    retirementCandidate
      ? h(
          'button',
          {
            class: 'chip retire',
            title: 'Unregister and archive this tool',
            on: {
              click: (_event, button) => {
                button.disabled = true;
                void retire(def.name).catch(() => {
                  button.disabled = false;
                });
              },
            },
          },
          'retire?',
        )
      : null,
  );
}

/**
 * Retiring frees the context the definition was costing. Archive rather than
 * delete: the provenance is worth keeping, and the row can come back.
 */
async function retire(name: string): Promise<void> {
  await registry?.unregister(name);
  await archiveTool(name);
}
