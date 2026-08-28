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
 * and resolves with a JSON *string*.
 *
 * The two sources disagree on the arguments: the spec's IDL declares
 * `object inputObject`, while Chrome's documentation passes a JSON string.
 * Chrome 152 follows its documentation - passing an object fails with
 * `UnknownError: Failed to parse input arguments` - so the string form is
 * tried first, with the object form as the fallback for an implementation
 * that follows the IDL instead. Verified against the real thing with
 * `npm run test:native`, not against the shim.
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
    raw = await mc.executeTool(tool, JSON.stringify(args), options);
  } catch (stringFormError) {
    // Do not narrow the retry by error type: Chrome reports the mismatch as an
    // UnknownError DOMException, not a TypeError, which an earlier version of
    // this fallback let through untouched.
    try {
      raw = await mc.executeTool(tool, args, options);
    } catch {
      throw stringFormError;
    }
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
