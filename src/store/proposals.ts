import { db } from './db';
import type { Proposal } from './types';

type Listener = (event: { kind: 'created' | 'updated'; proposal: Proposal }) => void;
const listeners = new Set<Listener>();

export function onProposalsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(kind: 'created' | 'updated', proposal: Proposal): void {
  for (const listener of listeners) listener({ kind, proposal });
}

export async function listProposals(status?: Proposal['status']): Promise<Proposal[]> {
  const database = await db();
  const all = await database.getAllFromIndex('proposals', 'by-createdAt');
  const filtered = status ? all.filter((proposal) => proposal.status === status) : all;
  return filtered.reverse();
}

export async function pendingProposals(): Promise<Proposal[]> {
  return listProposals('pending');
}

export async function getProposal(id: string): Promise<Proposal | undefined> {
  const database = await db();
  return database.get('proposals', id);
}

export async function createProposal(proposal: Proposal): Promise<Proposal> {
  const database = await db();
  await database.put('proposals', proposal);
  notify('created', proposal);
  return proposal;
}

export async function updateProposal(proposal: Proposal): Promise<Proposal> {
  const database = await db();
  await database.put('proposals', proposal);
  notify('updated', proposal);
  return proposal;
}
