import { binding, mc, MODE_LABEL } from '../webmcp/context';
import type { ToolDescriptor } from '../webmcp/types';
import { h, mount } from './dom';

/**
 * Mirrors exactly what the agent currently sees, re-read on every `toolchange`.
 *
 * The context-cost meter is the visible half of "tool surface entropy"
 * (build plan §3.7): every tool you keep is context your agent carries into
 * every future turn, and a surface that grows by accretion gets worse at
 * selection, not better.
 */

let container: HTMLElement | null = null;
let queue: Promise<void> = Promise.resolve();

/** Rough token estimate: 4 characters per token over what the model actually receives. */
export function contextCost(tool: ToolDescriptor): number {
  const payload = JSON.stringify({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  });
  return Math.ceil(payload.length / 4);
}

export function mountSurfacePanel(target: HTMLElement): void {
  container = target;
  mc.addEventListener('toolchange', () => void render());
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
        : h('ul', { class: 'surface-tools' }, ...tools.map(renderTool)),
    );
  });
  return queue;
}

function renderTool(tool: ToolDescriptor): HTMLElement {
  return h(
    'li',
    { class: 'surface-tool' },
    h(
      'details',
      {},
      h(
        'summary',
        {},
        h('span', { class: 'surface-name', text: tool.name }),
        tool.annotations?.readOnlyHint === true ? h('span', { class: 'tag ok', text: 'read' } ) : null,
        tool.annotations?.untrustedContentHint === true
          ? h('span', { class: 'tag warn', text: 'user-authored' })
          : null,
        h('span', { class: 'surface-cost', text: `~${contextCost(tool)}t` }),
      ),
      h('p', { class: 'surface-desc', text: tool.description }),
    ),
  );
}
