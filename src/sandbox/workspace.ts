import {
  allItems,
  buildItem,
  getItem,
  ItemValidationError,
  listItems,
  removeItem,
  saveItem,
  type ListQuery,
  type SaveItemInput,
} from '../store/items';
import type { Item } from '../store/types';

/**
 * The workspace as a tool sees it, in one of two modes.
 *
 * `live` writes through to IndexedDB. `dry` computes exactly the same result
 * against a shadow overlay and records what *would* have changed, so the review
 * drawer can show a real before/after diff instead of asking a user to audit
 * JavaScript. Multi-step tools behave sensibly in dry mode because reads see
 * the overlay too.
 */

export type Mutation =
  | { kind: 'create'; after: Item }
  | { kind: 'update'; before: Item; after: Item }
  | { kind: 'remove'; before: Item };

export interface WorkspaceSession {
  readonly mode: 'live' | 'dry';
  readonly mutations: Mutation[];
  readonly logs: string[];
  list(query: ListQuery): Promise<Item[]>;
  get(id: string): Promise<Item | null>;
  upsert(input: SaveItemInput): Promise<Item>;
  remove(id: string): Promise<boolean>;
  log(message: string): void;
}

const MAX_LOGS = 50;

export function liveSession(): WorkspaceSession {
  const mutations: Mutation[] = [];
  const logs: string[] = [];
  return {
    mode: 'live',
    mutations,
    logs,
    async list(query) {
      return (await listItems({ ...query, limit: query.limit ?? 200 })).items;
    },
    async get(id) {
      return (await getItem(id)) ?? null;
    },
    async upsert(input) {
      const before = input.id ? await getItem(input.id) : undefined;
      const after = await saveItem(input);
      mutations.push(before ? { kind: 'update', before, after } : { kind: 'create', after });
      return after;
    },
    async remove(id) {
      const before = await getItem(id);
      const removed = await removeItem(id);
      if (removed && before) mutations.push({ kind: 'remove', before });
      return removed;
    },
    log(message) {
      if (logs.length < MAX_LOGS) logs.push(message);
    },
  };
}

export function dryRunSession(): WorkspaceSession {
  const mutations: Mutation[] = [];
  const logs: string[] = [];
  /** id -> replacement, or null for "deleted in this dry run". */
  const overlay = new Map<string, Item | null>();

  const applyOverlay = (items: Item[]): Item[] => {
    const merged = items
      .map((item) => (overlay.has(item.id) ? overlay.get(item.id) ?? null : item))
      .filter((item): item is Item => item !== null);
    // Items created during the dry run are not in the base set.
    for (const [id, value] of overlay) {
      if (value && !items.some((item) => item.id === id)) merged.push(value);
    }
    return merged.sort((a, b) => b.addedAt - a.addedAt);
  };

  const currentGet = async (id: string): Promise<Item | undefined> => {
    if (overlay.has(id)) return overlay.get(id) ?? undefined;
    return getItem(id);
  };

  const matches = (item: Item, query: ListQuery): boolean => {
    if (query.status && item.status !== query.status) return false;
    if (query.tag) {
      const wanted = query.tag.toLowerCase();
      if (!item.tags.some((tag) => tag.toLowerCase() === wanted)) return false;
    }
    if (query.source && item.source.toLowerCase() !== query.source.toLowerCase()) return false;
    return true;
  };

  return {
    mode: 'dry',
    mutations,
    logs,
    async list(query) {
      const base = applyOverlay(await allItems());
      const filtered = base.filter((item) => matches(item, query));
      const offset = Math.max(0, Math.trunc(query.offset ?? 0));
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? 200), 1), 200);
      return filtered.slice(offset, offset + limit);
    },
    async get(id) {
      return (await currentGet(id)) ?? null;
    },
    async upsert(input) {
      const before = input.id ? await currentGet(input.id) : undefined;
      if (input.id && !before) {
        throw new ItemValidationError('id', `No item with id ${input.id}`);
      }
      const after = buildItem(before, input);
      overlay.set(after.id, after);
      mutations.push(before ? { kind: 'update', before, after } : { kind: 'create', after });
      return after;
    },
    async remove(id) {
      const before = await currentGet(id);
      if (!before) return false;
      overlay.set(id, null);
      mutations.push({ kind: 'remove', before });
      return true;
    },
    log(message) {
      if (logs.length < MAX_LOGS) logs.push(message);
    },
  };
}
