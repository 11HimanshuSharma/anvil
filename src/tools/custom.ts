import { sandbox } from '../sandbox/host';
import { record } from '../store/audit';
import { bumpStats } from '../store/tools';
import type { ToolDef } from '../store/types';
import type { ModelContextTool } from '../webmcp/types';

/**
 * A stored ToolDef, as the agent sees it.
 *
 * Two annotations matter here:
 *  - `readOnlyHint` is derived from the capabilities the user actually granted,
 *    not from anything the model claimed. ChatGPT's site-tools panel shows the
 *    read/write split, so this is visible in the judge's own UI.
 *  - `untrustedContentHint` is always true. This code was authored in-page at
 *    runtime rather than shipped by the site developer, which is exactly the
 *    case the spec's mitigation section is about.
 */
export function toModelContextTool(def: ToolDef): ModelContextTool {
  if (!def.descriptionAccepted) {
    // Belt and braces: the approval flow is the real gate, but a tool whose
    // description a human never accepted must never reach the model.
    throw new Error(`refusing to register "${def.name}": its description was never accepted`);
  }

  const writes = def.capabilities.includes('write:items') || def.capabilities.includes('net');

  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: def.inputSchema,
    annotations: {
      readOnlyHint: !writes,
      untrustedContentHint: true,
    },
    execute: async (args, options) => {
      const started = performance.now();
      const outcome = await sandbox.exec(
        {
          toolName: def.name,
          code: def.code,
          args,
          capabilities: def.capabilities,
          networkDomains: def.networkDomains,
          mode: 'live',
        },
        // Honour the agent's cancellation: it wires straight to the watchdog.
        options.signal,
      );

      await record({
        toolName: def.name,
        args,
        ok: outcome.ok,
        ...(outcome.ok ? { result: outcome.value } : { error: outcome.error ?? 'failed' }),
        durationMs: performance.now() - started,
      });
      await bumpStats(def.name, { ok: outcome.ok });

      if (outcome.ok) return outcome.value;

      // Return, don't throw: a rejection reaches the agent as a bare failure,
      // an object gives it something to reason about and retry from.
      return {
        ok: false,
        error: outcome.errorCode ?? 'execution_failed',
        detail: outcome.error ?? 'unknown error',
        ...(outcome.hint === undefined ? {} : { hint: outcome.hint }),
        ...(outcome.logs.length > 0 ? { logs: outcome.logs } : {}),
      };
    },
  };
}
