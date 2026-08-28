import type { ToolDef } from '../store/types';

/**
 * Tool surface entropy.
 *
 * Every tool you keep is context your agent carries into every future turn, and
 * Chrome's own guidance warns that overlapping tools make an agent worse at
 * choosing between them. A surface that grows by accretion - with names written
 * by a model optimising for helpfulness rather than discriminability - degrades
 * as the user invests more in it. Three months in you have normalize_company,
 * clean_company_name and fix_employer_field, and the agent picks wrong.
 *
 * This is a deliberately crude answer: no embeddings, no API calls, no
 * dependencies. Jaccard over description tokens, trigram similarity over names.
 */

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'by', 'with', 'this', 'that',
  'it', 'its', 'is', 'are', 'be', 'as', 'at', 'from', 'use', 'used', 'using', 'user', 'users',
  'when', 'what', 'which', 'their', 'them', 'they', 'you', 'your', 'returns', 'return', 'tool',
]);

export function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
  return new Set(tokens);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function trigrams(text: string): Set<string> {
  const padded = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) grams.add(padded.slice(i, i + 3));
  return grams;
}

export function trigramSimilarity(a: string, b: string): number {
  return jaccard(trigrams(a), trigrams(b));
}

export interface ComparableTool {
  name: string;
  title?: string;
  description: string;
}

/** score = 0.6 * jaccard(description tokens) + 0.4 * trigram(name) */
export function similarity(a: ComparableTool, b: ComparableTool): number {
  const textA = tokenize(`${a.name} ${a.title ?? ''} ${a.description}`);
  const textB = tokenize(`${b.name} ${b.title ?? ''} ${b.description}`);
  return 0.6 * jaccard(textA, textB) + 0.4 * trigramSimilarity(a.name, b.name);
}

/**
 * Calibrated, not guessed. `npm run calibrate` scores labelled pairs:
 *
 *   should flag      0.346 .. 0.600   (same job, different name)
 *   should not flag  0.000 .. 0.078   (genuinely different jobs)
 *
 * An earlier 0.55 sat inside the should-flag range and missed two of three
 * real duplicates - including `triage_queue` vs `triage_reading_queue`, which
 * is exactly the fragmentation this is for. 0.25 sits in the gap, biased
 * toward catching: a false positive is a suggestion the user can wave away,
 * while a false negative silently splits the tool surface.
 */
export const OVERLAP_THRESHOLD = 0.25;

export interface Overlap {
  name: string;
  score: number;
}

export function findOverlaps(
  draft: ComparableTool,
  existing: readonly ComparableTool[],
  threshold: number = OVERLAP_THRESHOLD,
): Overlap[] {
  return existing
    .filter((tool) => tool.name !== draft.name)
    .map((tool) => ({ name: tool.name, score: similarity(draft, tool) }))
    .filter((overlap) => overlap.score >= threshold)
    .sort((a, b) => b.score - a.score);
}

/** Rough token estimate over what the model actually receives for a tool. */
export function contextCost(tool: {
  name: string;
  description: string;
  inputSchema?: unknown;
}): number {
  const payload = JSON.stringify({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  });
  return Math.ceil((payload?.length ?? 0) / 4);
}

export const RETIREMENT_WINDOW_MS = 14 * 86_400_000;

/**
 * Tools that have earned their keep, and tools that have not.
 *
 * The window is a parameter rather than a constant so the UI can be shown and
 * tested without waiting a fortnight - see `retirementWindow()` in the surface
 * panel, which reads an override from the query string.
 */
export function retirementCandidates(
  tools: readonly ToolDef[],
  now: number = Date.now(),
  windowMs: number = RETIREMENT_WINDOW_MS,
): ToolDef[] {
  return tools.filter((tool) => {
    if (tool.archivedAt !== null) return false;
    if (now - tool.createdAt < windowMs) return false;
    if (tool.stats.calls === 0) return true;
    return tool.stats.lastUsedAt !== null && now - tool.stats.lastUsedAt > windowMs;
  });
}
