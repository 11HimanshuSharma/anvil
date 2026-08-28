import './style.css';
import { sandbox } from './sandbox/host';
import { record } from './store/audit';
import { ensureSeeded } from './store/items';
import { builtinTools } from './tools/builtin';
import { binding, mc } from './webmcp/context';
import { ToolRegistry } from './webmcp/registry';
import type { ModelContextTool } from './webmcp/types';
import { mountAuditLog } from './ui/auditLog';
import { el, h, mount } from './ui/dom';
import { mountItemsView } from './ui/items';
import { mountSurfacePanel } from './ui/surfacePanel';

export const registry = new ToolRegistry(mc);

/**
 * Wraps a tool so every invocation is recorded. The audit trail is the reason a
 * user can reasonably let an agent write to their workspace, so it covers the
 * built-ins too, not just the tools the agent authors later.
 */
function instrumented(tool: ModelContextTool): ModelContextTool {
  return {
    ...tool,
    execute: async (args, options) => {
      const started = performance.now();
      try {
        const result = await tool.execute(args, options);
        const failed =
          typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false;
        await record({
          toolName: tool.name,
          args,
          ok: !failed,
          result,
          durationMs: performance.now() - started,
          ...(failed ? { error: String((result as { detail?: unknown }).detail ?? 'failed') } : {}),
        });
        return result;
      } catch (thrown) {
        const message = thrown instanceof Error ? thrown.message : String(thrown);
        await record({
          toolName: tool.name,
          args,
          ok: false,
          error: message,
          durationMs: performance.now() - started,
        });
        // Return rather than rethrow: the agent can reason about an object.
        return { ok: false, error: 'execution_failed', detail: message };
      }
    },
  };
}

const TRY_PROMPTS: readonly string[] = [
  'What site tools are available?',
  'Find my unread links about databases and mark two of them as reading.',
  'Which items in my queue are near-duplicates of each other?',
  'Every link whose source is "newsletter" has tracking parameters in the URL. Clean them up and set the source to the real domain.',
];

function renderPrompts(target: HTMLElement): void {
  mount(
    target,
    ...TRY_PROMPTS.map((prompt) =>
      h(
        'li',
        { class: 'prompt' },
        h('span', { text: prompt }),
        h(
          'button',
          {
            class: 'icon',
            title: 'copy',
            on: {
              click: (_event, button) => {
                void navigator.clipboard
                  .writeText(prompt)
                  .then(() => {
                    button.textContent = '✓';
                    setTimeout(() => (button.textContent = 'copy'), 1200);
                  })
                  .catch(() => {
                    button.textContent = '!';
                  });
              },
            },
          },
          'copy',
        ),
      ),
    ),
  );
}

async function boot(): Promise<void> {
  await ensureSeeded();

  mountItemsView(el('items'));
  mountSurfacePanel(el('surface'));
  mountAuditLog(el('log'));
  renderPrompts(el('prompts'));

  for (const tool of builtinTools) {
    try {
      await registry.register(instrumented(tool));
    } catch (error) {
      console.error(`[anvil] failed to register ${tool.name}`, error);
    }
  }

  if (binding.mode === 'shim') {
    console.info(
      '[anvil] running in local mode — no WebMCP in this browser. Tools are registered ' +
        'against a local ModelContext so the page still works end to end.',
    );
  }
}

void boot();

// Exposed for DevTools and the Model Context Tool Inspector.
Object.assign(window, { anvil: { mc, binding, registry, sandbox } });
