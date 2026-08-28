import type { ModelContextLike, ModelContextMode } from './types';
import { createShim } from './shim';

export interface ModelContextBinding {
  readonly mc: ModelContextLike;
  readonly mode: ModelContextMode;
  /** True when the host exposes `executeTool`, so the page can dogfood the agent's path. */
  readonly canExecuteLocally: boolean;
}

function looksLikeModelContext(value: unknown): value is ModelContextLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ModelContextLike>;
  return (
    typeof candidate.registerTool === 'function' &&
    typeof candidate.getTools === 'function' &&
    typeof candidate.addEventListener === 'function'
  );
}

function detect(): ModelContextBinding {
  const fromDocument = (document as unknown as { modelContext?: unknown }).modelContext;
  if (looksLikeModelContext(fromDocument)) {
    return {
      mc: fromDocument,
      mode: 'native',
      canExecuteLocally: typeof fromDocument.executeTool === 'function',
    };
  }

  // Deprecated in Chromium 150 but still present in some builds.
  const fromNavigator = (navigator as unknown as { modelContext?: unknown }).modelContext;
  if (looksLikeModelContext(fromNavigator)) {
    return {
      mc: fromNavigator,
      mode: 'native-legacy',
      canExecuteLocally: typeof fromNavigator.executeTool === 'function',
    };
  }

  return { mc: createShim(), mode: 'shim', canExecuteLocally: true };
}

export const binding: ModelContextBinding = detect();
export const mc: ModelContextLike = binding.mc;

export const MODE_LABEL: Readonly<Record<ModelContextMode, string>> = Object.freeze({
  native: 'native · document.modelContext',
  'native-legacy': 'native · navigator.modelContext (legacy)',
  shim: 'local mode · no WebMCP in this browser',
});

/**
 * Calls a tool the way the page should call it.
 *
 * `executeTool` takes the RegisteredTool object from `getTools()`, not a name,
 * and resolves with a JSON *string*. Two independent sources also disagree on
 * the arguments: the spec IDL says `object inputObject`, while Chrome's
 * documentation passes a JSON string. Rather than bet on one, this tries the
 * object form and falls back to the string form on a TypeError.
 *
 * Every in-page call goes through here, so the page exercises the same path
 * the agent does instead of reaching for the callback directly.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  options: { signal?: AbortSignal } = {},
): Promise<unknown> {
  const tools = await mc.getTools();
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`No registered tool named "${name}"`);
  }

  let raw: unknown;
  try {
    raw = await mc.executeTool(tool, args, options);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    raw = await mc.executeTool(tool, JSON.stringify(args), options);
  }

  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // A tool that legitimately returns a bare string.
    return raw;
  }
}

export interface EnvironmentReport {
  readonly secureContext: boolean;
  readonly origin: string;
  readonly documentModelContext: boolean;
  readonly navigatorModelContext: boolean;
  readonly executeToolAvailable: boolean;
  readonly topLevel: boolean;
}

export function environmentReport(): EnvironmentReport {
  return {
    secureContext: window.isSecureContext,
    origin: window.location.origin,
    documentModelContext: 'modelContext' in document,
    navigatorModelContext: 'modelContext' in navigator,
    executeToolAvailable: binding.canExecuteLocally,
    topLevel: window.top === window.self,
  };
}
