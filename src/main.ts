import './style.css';
import { binding, environmentReport, mc, MODE_LABEL } from './webmcp/context';
import { ToolRegistry } from './webmcp/registry';
import type { ModelContextTool, ToolDescriptor } from './webmcp/types';

const HANDSHAKE_VALUE = 'banana-4417';
const registry = new ToolRegistry(mc);

/* ------------------------------------------------------------------ DOM ---- */

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const dom = {
  modeBadge: el<HTMLDivElement>('mode-badge'),
  envChips: el<HTMLUListElement>('env-chips'),
  toolList: el<HTMLOListElement>('tool-list'),
  toolCount: el<HTMLSpanElement>('tool-count'),
  toolChangeCount: el<HTMLElement>('toolchange-count'),
  log: el<HTMLOListElement>('log'),
  register: el<HTMLButtonElement>('btn-register'),
  unregister: el<HTMLButtonElement>('btn-unregister'),
  execute: el<HTMLButtonElement>('btn-execute'),
} as const;

type LogLevel = 'info' | 'ok' | 'error' | 'event';

function log(message: string, level: LogLevel = 'info'): void {
  const li = document.createElement('li');
  li.dataset['level'] = level;
  const time = document.createElement('span');
  time.className = 't';
  time.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const body = document.createElement('span');
  body.className = 'm';
  body.textContent = message;
  li.append(time, body);
  dom.log.prepend(li);
}

function describeError(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/* ---------------------------------------------------------------- tools ---- */

const workspaceStatus: ModelContextTool = {
  name: 'get_workspace_status',
  title: 'Workspace status',
  description:
    'Reports the current state of this Anvil probe workspace: how many site tools are registered right now and whether the page is running against a native WebMCP implementation. Use this to confirm the page is reachable before calling other tools.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  execute: async () => {
    const tools = await mc.getTools();
    return {
      status: 'ok',
      mode: binding.mode,
      registeredTools: tools.map((tool) => tool.name),
      checkedAt: new Date().toISOString(),
    };
  },
};

const secretHandshake: ModelContextTool = {
  name: 'secret_handshake',
  title: 'Secret handshake',
  description:
    'Returns a fixed handshake string that proves this tool was registered after the page loaded. Call it and report the exact string it returns.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  execute: () => HANDSHAKE_VALUE,
};

/* --------------------------------------------------------------- render ---- */

let toolChangeCount = 0;
let rendering: Promise<void> = Promise.resolve();

function renderTools(): Promise<void> {
  rendering = rendering.then(async () => {
    let tools: readonly ToolDescriptor[];
    try {
      tools = await mc.getTools();
    } catch (error) {
      log(`getTools() failed - ${describeError(error)}`, 'error');
      return;
    }

    dom.toolCount.textContent = String(tools.length);
    dom.toolList.replaceChildren();

    if (tools.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No tools registered.';
      dom.toolList.append(li);
      return;
    }

    for (const tool of tools) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = tool.name;
      li.append(name);
      if (tool.annotations?.readOnlyHint) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'read-only';
        li.append(tag);
      }
      const desc = document.createElement('p');
      desc.className = 'desc';
      desc.textContent = tool.description;
      li.append(desc);
      dom.toolList.append(li);
    }
  });
  return rendering;
}

function renderEnvironment(): void {
  const env = environmentReport();
  const chips: readonly (readonly [string, boolean])[] = [
    ['secure context', env.secureContext],
    ['top-level document', env.topLevel],
    ['document.modelContext', env.documentModelContext],
    ['navigator.modelContext', env.navigatorModelContext],
    ['executeTool()', env.executeToolAvailable],
  ];
  dom.envChips.replaceChildren();
  for (const [label, state] of chips) {
    const li = document.createElement('li');
    li.dataset['state'] = state ? 'yes' : 'no';
    li.textContent = `${state ? '✓' : '✕'} ${label}`;
    dom.envChips.append(li);
  }
  const origin = document.createElement('li');
  origin.textContent = env.origin;
  dom.envChips.append(origin);
}

function syncButtons(): void {
  const registered = registry.has(secretHandshake.name);
  dom.register.disabled = registered;
  dom.unregister.disabled = !registered;
  dom.execute.disabled = !registered;
}

/* -------------------------------------------------------------- actions ---- */

async function registerHandshake(): Promise<void> {
  dom.register.disabled = true;
  try {
    await registry.register(secretHandshake);
    log(`registered ${secretHandshake.name} - no reload. Ask the agent to call it now.`, 'ok');
  } catch (error) {
    log(`register failed - ${describeError(error)}`, 'error');
  } finally {
    syncButtons();
    await renderTools();
  }
}

async function unregisterHandshake(): Promise<void> {
  try {
    await registry.unregister(secretHandshake.name);
    log(`unregistered ${secretHandshake.name} (aborted its signal)`, 'ok');
  } catch (error) {
    log(`unregister failed - ${describeError(error)}`, 'error');
  } finally {
    syncButtons();
    await renderTools();
  }
}

/**
 * Deliberately goes through `getTools()` then `executeTool()` - the same path
 * the agent takes - rather than calling the callback directly. If the host has
 * no `executeTool`, fall back and say so in the log instead of pretending.
 */
async function executeHandshake(): Promise<void> {
  const name = secretHandshake.name;
  try {
    const tools = await mc.getTools();
    if (!tools.some((tool) => tool.name === name)) {
      log(`${name} is not in getTools() - nothing to call`, 'error');
      return;
    }

    let result: unknown;
    if (binding.canExecuteLocally) {
      result = await mc.executeTool(name, {});
    } else {
      const tool = registry.get(name);
      if (!tool) throw new Error(`${name} is not held by the registry`);
      result = await tool.execute({}, {});
      log('executeTool() unavailable in this browser - called the callback directly', 'info');
    }

    const rendered = typeof result === 'string' ? result : JSON.stringify(result);
    const matched = rendered.includes(HANDSHAKE_VALUE);
    log(`${name} -> ${rendered}`, matched ? 'ok' : 'error');
  } catch (error) {
    log(`executeTool failed - ${describeError(error)}`, 'error');
  }
}

/* ----------------------------------------------------------------- boot ---- */

async function boot(): Promise<void> {
  dom.modeBadge.dataset['mode'] = binding.mode;
  dom.modeBadge.textContent = MODE_LABEL[binding.mode];
  renderEnvironment();

  mc.addEventListener('toolchange', () => {
    toolChangeCount += 1;
    dom.toolChangeCount.textContent = String(toolChangeCount);
    log('toolchange event', 'event');
    void renderTools();
  });

  dom.register.addEventListener('click', () => void registerHandshake());
  dom.unregister.addEventListener('click', () => void unregisterHandshake());
  dom.execute.addEventListener('click', () => void executeHandshake());

  log(`mode: ${MODE_LABEL[binding.mode]}`, binding.mode === 'shim' ? 'info' : 'ok');

  try {
    await registry.register(workspaceStatus);
    log(`registered ${workspaceStatus.name} at load`, 'ok');
  } catch (error) {
    log(`initial register failed - ${describeError(error)}`, 'error');
  }

  syncButtons();
  await renderTools();
}

void boot();

// Exposed for manual probing from DevTools and the Model Context Tool Inspector.
Object.assign(window, { anvil: { mc, binding, registry, renderTools } });
