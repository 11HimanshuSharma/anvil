import { db, newId } from './db';
import { buildSeedItems } from './seed';
import { isItemStatus, type Item, type ItemStatus } from './types';

/* ------------------------------------------------------------- change bus -- */

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribe to any mutation of the item store. Returns an unsubscribe fn. */
export function onItemsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/* ------------------------------------------------------------------ seed --- */

/** Seeds the workspace on first run so a cold visitor has something to play with. */
export async function ensureSeeded(): Promise<number> {
  const database = await db();
  const existing = await database.count('items');
  if (existing > 0) return existing;

  const tx = database.transaction('items', 'readwrite');
  const store = tx.objectStore('items');
  const seeded = buildSeedItems();
  await Promise.all(seeded.map((item) => store.put(item)));
  await tx.done;
  notify();
  return seeded.length;
}

/** Wipes items and reinstates the seed set. Used by the "reset workspace" action. */
export async function reseed(): Promise<number> {
  const database = await db();
  const tx = database.transaction('items', 'readwrite');
  await tx.objectStore('items').clear();
  const seeded = buildSeedItems();
  await Promise.all(seeded.map((item) => tx.objectStore('items').put(item)));
  await tx.done;
  notify();
  return seeded.length;
}

/* ----------------------------------------------------------------- reads --- */

export interface ListQuery {
  status?: ItemStatus;
  tag?: string;
  source?: string;
  limit?: number;
  offset?: number;
}

export interface ListResult {
  items: Item[];
  total: number;
  limit: number;
  offset: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

/** Tag and source matching is case-insensitive on purpose: the seed data is inconsistent. */
function matchesQuery(item: Item, query: ListQuery): boolean {
  if (query.status && item.status !== query.status) return false;
  if (query.tag) {
    const wanted = query.tag.toLowerCase();
    if (!item.tags.some((tag) => tag.toLowerCase() === wanted)) return false;
  }
  if (query.source && item.source.toLowerCase() !== query.source.toLowerCase()) return false;
  return true;
}

export async function allItems(): Promise<Item[]> {
  const database = await db();
  const items = await database.getAll('items');
  return items.sort((a, b) => b.addedAt - a.addedAt);
}

export async function listItems(query: ListQuery = {}): Promise<ListResult> {
  const matching = (await allItems()).filter((item) => matchesQuery(item, query));
  const limit = clampLimit(query.limit);
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));
  return {
    items: matching.slice(offset, offset + limit),
    total: matching.length,
    limit,
    offset,
  };
}

export async function getItem(id: string): Promise<Item | undefined> {
  const database = await db();
  return database.get('items', id);
}

export interface SearchQuery {
  query: string;
  status?: ItemStatus;
  limit?: number;
}

export async function searchItems(search: SearchQuery): Promise<Item[]> {
  const needle = search.query.trim().toLowerCase();
  const limit = clampLimit(search.limit);
  const pool = await allItems();
  return pool
    .filter((item) => (search.status ? item.status === search.status : true))
    .filter((item) =>
      needle === ''
        ? true
        : `${item.title} ${item.url} ${item.notes} ${item.tags.join(' ')}`
            .toLowerCase()
            .includes(needle),
    )
    .slice(0, limit);
}

export async function allTags(): Promise<{ tag: string; count: number }[]> {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const item of await allItems()) {
    for (const tag of item.tags) {
      const key = tag.toLowerCase();
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { tag, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export async function countByStatus(): Promise<Record<ItemStatus, number>> {
  const tally: Record<ItemStatus, number> = { unread: 0, reading: 0, done: 0, archived: 0 };
  for (const item of await allItems()) tally[item.status] += 1;
  return tally;
}

/* ---------------------------------------------------------------- writes --- */

export interface SaveItemInput {
  id?: string;
  url?: string;
  title?: string;
  source?: string;
  tags?: string[];
  status?: string;
  notes?: string;
}

export class ItemValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'ItemValidationError';
    this.field = field;
  }
}

function normaliseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') throw new ItemValidationError('url', 'url is required');
  try {
    return new URL(trimmed).toString();
  } catch {
    throw new ItemValidationError('url', `Not a valid absolute URL: ${trimmed}`);
  }
}

function deriveSource(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

function deriveTitle(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : parsed.hostname;
  } catch {
    return url;
  }
}

function normaliseTags(tags: unknown): string[] | undefined {
  if (tags === undefined) return undefined;
  if (!Array.isArray(tags)) throw new ItemValidationError('tags', 'tags must be an array of strings');
  const cleaned = tags
    .map((tag) => String(tag).trim())
    .filter((tag) => tag !== '');
  return [...new Set(cleaned)];
}

function normaliseStatus(status: unknown): ItemStatus | undefined {
  if (status === undefined) return undefined;
  if (!isItemStatus(status)) {
    throw new ItemValidationError(
      'status',
      `status must be one of unread, reading, done, archived (got ${JSON.stringify(status)})`,
    );
  }
  return status;
}

/** Upsert. An `id` that exists updates in place; anything else creates. */
export async function saveItem(input: SaveItemInput): Promise<Item> {
  const database = await db();
  const now = Date.now();
  const existing = input.id ? await database.get('items', input.id) : undefined;

  if (input.id && !existing) {
    throw new ItemValidationError('id', `No item with id ${input.id}`);
  }

  const tags = normaliseTags(input.tags);
  const status = normaliseStatus(input.status);

  let next: Item;
  if (existing) {
    next = {
      ...existing,
      ...(input.url !== undefined ? { url: normaliseUrl(input.url) } : {}),
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.source !== undefined ? { source: input.source.trim() } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      updatedAt: now,
    };
  } else {
    if (input.url === undefined) {
      throw new ItemValidationError('url', 'url is required when creating an item');
    }
    const url = normaliseUrl(input.url);
    next = {
      id: newId('item'),
      url,
      title: input.title?.trim() || deriveTitle(url),
      source: input.source?.trim() || deriveSource(url),
      tags: tags ?? [],
      status: status ?? 'unread',
      notes: input.notes ?? '',
      addedAt: now,
      updatedAt: now,
    };
  }

  await database.put('items', next);
  notify();
  return next;
}

export async function removeItem(id: string): Promise<boolean> {
  const database = await db();
  const existing = await database.get('items', id);
  if (!existing) return false;
  await database.delete('items', id);
  notify();
  return true;
}
