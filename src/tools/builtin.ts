import {
  getItem,
  ItemValidationError,
  listItems,
  removeItem,
  saveItem,
  searchItems,
  type SaveItemInput,
} from '../store/items';
import { toToolItem, toToolItemSummary } from '../store/shape';
import { isItemStatus, type ItemStatus } from '../store/types';
import type { ModelContextTool } from '../webmcp/types';

/**
 * The five workspace tools.
 *
 * Descriptions follow Chrome's guidance: say what the tool does *and* when to
 * reach for it, use positive language, and never write "don't use this for X".
 * They are also the only prose the model sees, so they are worth more care than
 * the code beneath them.
 */

/* ------------------------------------------------------------- arg coercion */

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined || value.trim() === '') {
    throw new ItemValidationError(key, `${key} is required`);
  }
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalStatus(args: Record<string, unknown>, key: string): ItemStatus | undefined {
  const value = optionalString(args, key);
  if (value === undefined) return undefined;
  if (!isItemStatus(value)) {
    throw new ItemValidationError(key, `${key} must be one of: unread, reading, done, archived`);
  }
  return value;
}

function optionalTags(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((tag) => String(tag));
  // Models sometimes send a comma-separated string. Accept it rather than fail.
  return String(value)
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
}

/**
 * Spread helper: `...opt('status', maybeStatus)` adds the key only when the
 * value is defined, which is what `exactOptionalPropertyTypes` demands.
 */
function opt<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/* -------------------------------------------------------------- shaping ---- */

const summarise = toToolItemSummary;
const full = toToolItem;

export interface ToolFailure {
  ok: false;
  error: string;
  detail: string;
  hint?: string;
}

/**
 * Structured failures beat thrown rejections: a rejection reaches the agent as
 * a bare failure, an object gives it something to reason about and retry from.
 */
function failure(error: string, detail: string, hint?: string): ToolFailure {
  return { ok: false, error, detail, ...(hint === undefined ? {} : { hint }) };
}

function fromThrown(thrown: unknown): ToolFailure {
  if (thrown instanceof ItemValidationError) {
    return failure('invalid_argument', thrown.message, `Fix the "${thrown.field}" argument and retry.`);
  }
  return failure('execution_failed', thrown instanceof Error ? thrown.message : String(thrown));
}

const STATUS_ENUM = ['unread', 'reading', 'done', 'archived'] as const;

/* ---------------------------------------------------------------- tools ---- */

const listItemsTool: ModelContextTool = {
  name: 'list_items',
  title: 'List saved links',
  description:
    "Lists the links saved in this workspace, newest first, optionally narrowed by reading status, tag, or source. Returns each item's id, title, URL, source, tags, and status, plus the total number of matches so you can page through with limit and offset. Use this to survey the queue before deciding what to read, update, or clean up.",
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: [...STATUS_ENUM],
        description: 'Optional filter by reading status.',
      },
      tag: {
        type: 'string',
        description: 'Optional filter by tag. Matching is case-insensitive.',
      },
      source: {
        type: 'string',
        description: 'Optional filter by source name, for example "arXiv". Case-insensitive.',
      },
      limit: { type: 'number', description: 'Maximum items to return. Defaults to 20, caps at 200.' },
      offset: { type: 'number', description: 'How many matches to skip. Defaults to 0.' },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  execute: async (args) => {
    try {
      const result = await listItems({
        ...opt('status', optionalStatus(args, 'status')),
        ...opt('tag', optionalString(args, 'tag')),
        ...opt('source', optionalString(args, 'source')),
        ...opt('limit', optionalNumber(args, 'limit')),
        ...opt('offset', optionalNumber(args, 'offset')),
      });
      return {
        items: result.items.map(summarise),
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        returned: result.items.length,
      };
    } catch (thrown) {
      return fromThrown(thrown);
    }
  },
};

const getItemTool: ModelContextTool = {
  name: 'get_item',
  title: 'Get one saved link',
  description:
    'Returns the complete record for a single saved link, including its notes and last-updated time. Use this after list_items or search_items when you need the full detail of one item before updating it.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The item id, as returned by list_items or search_items.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  execute: async (args) => {
    try {
      const id = requiredString(args, 'id');
      const item = await getItem(id);
      if (!item) {
        return failure('not_found', `No item with id ${id}`, 'Call list_items to see the current ids.');
      }
      return { item: full(item) };
    } catch (thrown) {
      return fromThrown(thrown);
    }
  },
};

const searchItemsTool: ModelContextTool = {
  name: 'search_items',
  title: 'Search saved links',
  description:
    "Searches the saved links by matching text against title, URL, notes, and tags. Returns matching items with their ids, titles, URLs, tags, and status. Use this to find specific items by keyword before reading or updating them, when you already know roughly what you're looking for.",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text to match. Case-insensitive substring match.' },
      status: {
        type: 'string',
        enum: [...STATUS_ENUM],
        description: 'Optional filter by reading status.',
      },
      limit: { type: 'number', description: 'Maximum results to return. Defaults to 20.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  execute: async (args) => {
    try {
      const items = await searchItems({
        query: requiredString(args, 'query'),
        ...opt('status', optionalStatus(args, 'status')),
        ...opt('limit', optionalNumber(args, 'limit')),
      });
      return { items: items.map(summarise), returned: items.length };
    } catch (thrown) {
      return fromThrown(thrown);
    }
  },
};

const saveItemTool: ModelContextTool = {
  name: 'save_item',
  title: 'Save or update a link',
  description:
    'Creates a new saved link, or updates an existing one when an id is supplied. Only the fields you pass are changed; everything else is left as it is. Use this to add a link the user mentions, to change reading status, to retitle an item, or to edit its tags and notes.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'Existing item id to update. Omit to create a new item.',
      },
      url: {
        type: 'string',
        description: 'Absolute URL. Required when creating, optional when updating.',
      },
      title: { type: 'string', description: 'Human-readable title. Derived from the URL if omitted.' },
      source: {
        type: 'string',
        description: 'Where it came from, for example "arXiv". Derived from the hostname if omitted.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Full replacement tag list. Pass the existing tags plus your additions to append.',
      },
      status: {
        type: 'string',
        enum: [...STATUS_ENUM],
        description: 'Reading status. Defaults to unread on new items.',
      },
      notes: { type: 'string', description: 'Free-text notes. Replaces the existing notes.' },
    },
    additionalProperties: false,
  },
  execute: async (args) => {
    try {
      const input: SaveItemInput = {
        ...opt('id', optionalString(args, 'id')),
        ...opt('url', optionalString(args, 'url')),
        ...opt('title', optionalString(args, 'title')),
        ...opt('source', optionalString(args, 'source')),
        ...opt('tags', optionalTags(args, 'tags')),
        ...opt('status', optionalString(args, 'status')),
        ...opt('notes', optionalString(args, 'notes')),
      };
      const created = input.id === undefined;
      const item = await saveItem(input);
      return { item: full(item), created };
    } catch (thrown) {
      return fromThrown(thrown);
    }
  },
};

const removeItemTool: ModelContextTool = {
  name: 'remove_item',
  title: 'Delete a saved link',
  description:
    'Permanently deletes one saved link by id. Confirm with the user which item they mean before calling this, and report the title you deleted so they can tell it was the right one.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The item id to delete.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  annotations: { destructiveHint: true, idempotentHint: true },
  execute: async (args) => {
    try {
      const id = requiredString(args, 'id');
      const item = await getItem(id);
      if (!item) {
        return failure('not_found', `No item with id ${id}`, 'Call list_items to see the current ids.');
      }
      await removeItem(id);
      return { removed: true, id, title: item.title };
    } catch (thrown) {
      return fromThrown(thrown);
    }
  },
};

export const builtinTools: readonly ModelContextTool[] = Object.freeze([
  listItemsTool,
  getItemTool,
  searchItemsTool,
  saveItemTool,
  removeItemTool,
]);
