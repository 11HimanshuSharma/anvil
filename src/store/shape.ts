import type { Item } from './types';

/**
 * One shape for items, wherever a model or a tool sees them.
 *
 * There used to be two: the built-in tools returned ISO timestamps while
 * host.items.list handed sandboxed tool code raw epoch numbers. Agent-written
 * tools had to defend against both, which is exactly the kind of papercut that
 * makes a model's code subtly wrong.
 */
export interface ToolItem {
  id: string;
  title: string;
  url: string;
  source: string;
  tags: string[];
  status: string;
  /** ISO 8601. Parse with Date.parse() if you need to compare. */
  addedAt: string;
  updatedAt: string;
  notes: string;
}

export function toToolItem(item: Item): ToolItem {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    source: item.source,
    tags: [...item.tags],
    status: item.status,
    addedAt: new Date(item.addedAt).toISOString(),
    updatedAt: new Date(item.updatedAt).toISOString(),
    notes: item.notes,
  };
}

/** List responses drop notes: full records add up fast in a model's context. */
export function toToolItemSummary(item: Item): Omit<ToolItem, 'notes' | 'updatedAt'> & { hasNotes: boolean } {
  const { notes, updatedAt: _updatedAt, ...rest } = toToolItem(item);
  return { ...rest, hasNotes: notes.trim() !== '' };
}
