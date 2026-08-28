import { db, newId } from './db';
import type { AuditEntry } from './types';

/**
 * Every tool invocation, with args, outcome and duration.
 *
 * This is a product feature, not a debug aid: if an agent is going to run code
 * against your data, you should be able to see exactly what it did.
 */

type Listener = () => void;
const listeners = new Set<Listener>();

export function onAuditChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Results land in the model's context, so keep the stored copy bounded too. */
const MAX_RESULT_CHARS = 2_000;
const MAX_ENTRIES = 500;
const MAX_ARG_CHARS = 300;

function truncate(value: unknown): unknown {
  if (value === undefined) return undefined;
  let serialised: string;
  try {
    serialised = JSON.stringify(value) ?? 'null';
  } catch {
    return '[unserialisable]';
  }
  if (serialised.length <= MAX_RESULT_CHARS) return value;
  return `${serialised.slice(0, MAX_RESULT_CHARS)}… (${serialised.length} chars)`;
}

/** Per-value truncation, so a large `code` argument cannot dominate the row. */
function truncateArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > MAX_ARG_CHARS) {
      out[key] = `${value.slice(0, MAX_ARG_CHARS)}… (${value.length} chars)`;
    } else {
      out[key] = truncate(value);
    }
  }
  return out;
}

export interface RecordInput {
  toolName: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

export async function record(input: RecordInput): Promise<AuditEntry> {
  const entry: AuditEntry = {
    id: newId('audit'),
    ts: Date.now(),
    toolName: input.toolName,
    // Bounded like the result. propose_tool's args carry an entire tool's
    // source, and this store keeps 500 rows.
    args: truncateArgs(input.args),
    ok: input.ok,
    ...(input.result === undefined ? {} : { result: truncate(input.result) }),
    ...(input.error === undefined ? {} : { error: input.error }),
    durationMs: Math.round(input.durationMs),
  };

  const database = await db();
  await database.put('audit', entry);

  // Cheap ring-buffer: trim the oldest once we drift over the cap.
  const count = await database.count('audit');
  if (count > MAX_ENTRIES) {
    const tx = database.transaction('audit', 'readwrite');
    const index = tx.store.index('by-ts');
    let cursor = await index.openCursor();
    let toDelete = count - MAX_ENTRIES;
    while (cursor && toDelete > 0) {
      await cursor.delete();
      toDelete -= 1;
      cursor = await cursor.continue();
    }
    await tx.done;
  }

  for (const listener of listeners) listener();
  return entry;
}

export async function recent(limit = 50): Promise<AuditEntry[]> {
  const database = await db();
  const entries = await database.getAllFromIndex('audit', 'by-ts');
  return entries.slice(-limit).reverse();
}

export async function clear(): Promise<void> {
  const database = await db();
  await database.clear('audit');
  for (const listener of listeners) listener();
}
