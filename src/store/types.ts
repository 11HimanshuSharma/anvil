/** Domain types for the Anvil workspace. Build plan §3.3. */

import type { JsonSchema } from '../webmcp/types';

export const ITEM_STATUSES = ['unread', 'reading', 'done', 'archived'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export function isItemStatus(value: unknown): value is ItemStatus {
  return typeof value === 'string' && (ITEM_STATUSES as readonly string[]).includes(value);
}

export interface Item {
  id: string;
  url: string;
  title: string;
  /** Where it came from. Deliberately free-text: real data is inconsistent here. */
  source: string;
  tags: string[];
  status: ItemStatus;
  notes: string;
  addedAt: number;
  updatedAt: number;
}

export const CAPABILITIES = ['read:items', 'write:items', 'net'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
}

export interface ToolStats {
  calls: number;
  errors: number;
  lastUsedAt: number | null;
}

export interface ToolTestCase {
  args: Record<string, unknown>;
  expectation: string;
}

export interface ToolDef {
  name: string;
  title: string;
  /** The text the human accepted. This is what steers the model in future sessions. */
  description: string;
  /** What the model originally wrote, kept for provenance. */
  agentDraftDescription?: string;
  inputSchema: JsonSchema;
  /** Function body: (args, host) => any */
  code: string;
  capabilities: Capability[];
  /** Exact hostnames. Only meaningful when capabilities includes 'net'. */
  networkDomains: string[];
  provenance: 'agent' | 'human';
  /** Hard gate: a tool cannot be registered while this is false. */
  descriptionAccepted: boolean;
  version: number;
  createdAt: number;
  archivedAt: number | null;
  stats: ToolStats;
  testCases: ToolTestCase[];
}

export interface DryRunResult {
  args: Record<string, unknown>;
  ok: boolean;
  result?: unknown;
  error?: string;
  ms: number;
}

export interface Proposal {
  id: string;
  draft: ToolDef;
  rationale: string;
  dryRuns: DryRunResult[];
  /** Injection-scan hits. Flagged, never auto-blocked. */
  scanFlags: string[];
  /** Existing tool names above the similarity threshold. */
  overlapsWith: string[];
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
}

export interface AuditEntry {
  id: string;
  ts: number;
  toolName: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}
