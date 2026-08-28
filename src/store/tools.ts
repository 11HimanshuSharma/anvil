import { db } from './db';
import type { ToolDef } from './types';

type Listener = () => void;
const listeners = new Set<Listener>();

export function onToolsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

export async function listTools(options: { includeArchived?: boolean } = {}): Promise<ToolDef[]> {
  const database = await db();
  const all = await database.getAll('tools');
  const filtered = options.includeArchived ? all : all.filter((tool) => tool.archivedAt === null);
  return filtered.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getTool(name: string): Promise<ToolDef | undefined> {
  const database = await db();
  return database.get('tools', name);
}

export async function putTool(def: ToolDef): Promise<ToolDef> {
  const database = await db();
  await database.put('tools', def);
  notify();
  return def;
}

/**
 * Retiring a tool archives it rather than deleting it: the provenance - who
 * authored it, what description a human accepted - is worth keeping even once
 * the tool has stopped earning the context it costs.
 */
export async function archiveTool(name: string): Promise<ToolDef | undefined> {
  const existing = await getTool(name);
  if (!existing) return undefined;
  return putTool({ ...existing, archivedAt: Date.now() });
}

export async function bumpStats(name: string, outcome: { ok: boolean }): Promise<void> {
  const existing = await getTool(name);
  if (!existing) return;
  await putTool({
    ...existing,
    stats: {
      calls: existing.stats.calls + 1,
      errors: existing.stats.errors + (outcome.ok ? 0 : 1),
      lastUsedAt: Date.now(),
    },
  });
}
