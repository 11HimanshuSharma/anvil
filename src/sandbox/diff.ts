import type { Item } from '../store/types';
import type { Mutation } from './workspace';

/**
 * Compact, storable summaries of what a tool changed (or would have changed).
 *
 * A `Mutation` carries whole `Item` records, which is more than a proposal
 * needs to keep. These summaries survive a round trip through IndexedDB and are
 * what the review drawer renders as a before/after diff - the thing that lets
 * someone approve a tool by its behaviour rather than by reading its source.
 */

export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

export interface MutationSummary {
  kind: 'create' | 'update' | 'remove';
  id: string;
  title: string;
  changes: FieldChange[];
}

export function summariseMutation(mutation: Mutation): MutationSummary {
  if (mutation.kind === 'create') {
    return {
      kind: 'create',
      id: mutation.after.id,
      title: mutation.after.title || mutation.after.url,
      changes: [],
    };
  }
  if (mutation.kind === 'remove') {
    return {
      kind: 'remove',
      id: mutation.before.id,
      title: mutation.before.title || mutation.before.url,
      changes: [],
    };
  }
  return {
    kind: 'update',
    id: mutation.after.id,
    title: mutation.after.title || mutation.after.url,
    changes: fieldChanges(mutation.before, mutation.after),
  };
}

function fieldChanges(before: Item, after: Item): FieldChange[] {
  const changes: FieldChange[] = [];
  const compare = (field: string, a: string, b: string): void => {
    if (a !== b) changes.push({ field, before: a, after: b });
  };
  compare('title', before.title, after.title);
  compare('url', before.url, after.url);
  compare('source', before.source, after.source);
  compare('status', before.status, after.status);
  compare('tags', before.tags.join(', '), after.tags.join(', '));
  compare('notes', before.notes, after.notes);
  return changes;
}

export function summariseMutations(mutations: readonly Mutation[]): MutationSummary[] {
  return mutations.map(summariseMutation);
}
