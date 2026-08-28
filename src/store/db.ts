import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AuditEntry, Item, ItemStatus, Proposal, ToolDef } from './types';

export const DB_NAME = 'anvil';
export const DB_VERSION = 1;

export interface AnvilDB extends DBSchema {
  items: {
    key: string;
    value: Item;
    indexes: { 'by-status': ItemStatus; 'by-addedAt': number };
  };
  tools: {
    key: string;
    value: ToolDef;
  };
  proposals: {
    key: string;
    value: Proposal;
    indexes: { 'by-createdAt': number };
  };
  audit: {
    key: string;
    value: AuditEntry;
    indexes: { 'by-ts': number };
  };
}

let handle: Promise<IDBPDatabase<AnvilDB>> | null = null;

export function db(): Promise<IDBPDatabase<AnvilDB>> {
  handle ??= openDB<AnvilDB>(DB_NAME, DB_VERSION, {
    upgrade(database, oldVersion) {
      // Single migration: v0 -> v1. Keep it that way until after the deadline.
      if (oldVersion < 1) {
        const items = database.createObjectStore('items', { keyPath: 'id' });
        items.createIndex('by-status', 'status');
        items.createIndex('by-addedAt', 'addedAt');

        database.createObjectStore('tools', { keyPath: 'name' });

        const proposals = database.createObjectStore('proposals', { keyPath: 'id' });
        proposals.createIndex('by-createdAt', 'createdAt');

        const audit = database.createObjectStore('audit', { keyPath: 'id' });
        audit.createIndex('by-ts', 'ts');
      }
    },
    blocked() {
      console.warn('[anvil] another tab is holding an older version of the database open');
    },
  });
  return handle;
}

/** Test/reset hook: wipes every store but keeps the schema. */
export async function clearAll(): Promise<void> {
  const database = await db();
  const tx = database.transaction(['items', 'tools', 'proposals', 'audit'], 'readwrite');
  await Promise.all([
    tx.objectStore('items').clear(),
    tx.objectStore('tools').clear(),
    tx.objectStore('proposals').clear(),
    tx.objectStore('audit').clear(),
    tx.done,
  ]);
}

export function newId(prefix: string): string {
  const random =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.floor(Math.random() * 0xffffffff).toString(16);
  return `${prefix}_${random}`;
}
