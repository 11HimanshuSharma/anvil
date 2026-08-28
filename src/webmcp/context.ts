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
