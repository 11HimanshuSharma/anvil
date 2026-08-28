import { sandbox } from '../sandbox/host';
import { newId } from '../store/db';
import { createProposal, getProposal, updateProposal } from '../store/proposals';
import { listTools } from '../store/tools';
import { isCapability, type Capability, type DryRunResult, type Proposal, type ToolDef } from '../store/types';
import { findOverlaps } from '../surface/entropy';
import { scanDescription, scanSchema } from '../surface/scan';
import { isToolNameValid, type JsonSchema, type ModelContextTool } from '../webmcp/types';
import { builtinTools } from './builtin';

/**
 * The three meta tools.
 *
 * The important property of this file is what it does NOT contain: there is no
 * import of the ToolRegistry, and no code path from an agent call to a live
 * registration. `propose_tool` writes a pending row and stops. A human clicking
 * Approve in the page is the only thing that can register a tool.
 */

interface Failure {
  ok: false;
  error: string;
  detail: string;
  hint?: string;
}

function fail(error: string, detail: string, hint?: string): Failure {
  return { ok: false, error, detail, ...(hint === undefined ? {} : { hint }) };
}

/* ------------------------------------------------------------ validation --- */

function asString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return value === undefined || value === null ? undefined : String(value);
}

async function reservedNames(): Promise<Set<string>> {
  const custom = await listTools({ includeArchived: true });
  return new Set([...builtinTools.map((tool) => tool.name), ...custom.map((tool) => tool.name)]);
}

function parseCapabilities(value: unknown): Capability[] | Failure {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    return fail('invalid_argument', 'capabilities must be an array', 'Use [] for pure computation.');
  }
  const invalid = value.filter((entry) => !isCapability(entry));
  if (invalid.length > 0) {
    return fail(
      'invalid_argument',
      `Unknown capabilities: ${invalid.map((entry) => JSON.stringify(entry)).join(', ')}`,
      'Valid values are "read:items", "write:items" and "net".',
    );
  }
  return value as Capability[];
}

function isFailure(value: unknown): value is Failure {
  return typeof value === 'object' && value !== null && (value as Failure).ok === false;
}

/* ----------------------------------------------------------- propose_tool -- */

const PROPOSE_DESCRIPTION = [
  'Submits a draft tool for the user to review.',
  'This does not register the tool and does not make it callable.',
  'The user reviews the behaviour in the page - the capabilities it requests, a dry run against',
  'their real data, and the description text - and then approves or rejects it.',
  'Returns a proposal id and a pending status.',
  'After proposing, tell the user a proposal is waiting for review in the page, and wait for them',
  'to confirm they approved it before trying to call the new tool.',
  'Call list_available_tools first to check whether a suitable tool already exists,',
  'and dry_run_draft afterwards to check the code actually works.',
].join(' ');

const proposeTool: ModelContextTool = {
  name: 'propose_tool',
  title: 'Propose a new tool',
  description: PROPOSE_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'snake_case identifier, 1-128 characters, letters, digits, underscore, hyphen and period only.',
      },
      title: { type: 'string', description: 'Short human-readable label.' },
      description: {
        type: 'string',
        description:
          'What the tool does and when to use it. The user will review and may rewrite this before it is registered.',
      },
      inputSchema: {
        type: 'object',
        description: 'JSON Schema object describing the tool arguments.',
      },
      code: {
        type: 'string',
        description:
          'JavaScript function body. Receives (args, host) and may use await. host.items.list(query) and host.items.get(id) are available with read:items; host.items.upsert(item) and host.items.remove(id) with write:items; host.fetchJson(url) with net; host.log(message) always. There is no DOM and no network except through host. Must return a JSON-serialisable value under 64 kB.',
      },
      capabilities: {
        type: 'array',
        items: { type: 'string', enum: ['read:items', 'write:items', 'net'] },
        description: 'Request the minimum needed. Pure computation needs none.',
      },
      networkDomains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact hostnames this tool may reach. Only used when capabilities includes net.',
      },
      rationale: {
        type: 'string',
        description: 'Why this is worth making permanent, in one or two sentences for the user.',
      },
      testCases: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            args: { type: 'object' },
            expectation: { type: 'string' },
          },
        },
        description:
          'Two or three example calls with what you expect to happen. These are dry-run immediately and the results are shown to the user.',
      },
    },
    required: ['name', 'description', 'inputSchema', 'code', 'capabilities', 'rationale'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false },
  execute: async (args) => {
    const name = asString(args, 'name');
    const description = asString(args, 'description');
    const code = asString(args, 'code');
    const rationale = asString(args, 'rationale') ?? '';

    if (!name || !isToolNameValid(name)) {
      return fail(
        'invalid_name',
        `Tool names must match [A-Za-z0-9_.-] and be 1-128 characters (got ${JSON.stringify(name)})`,
        'Try a snake_case name like find_near_duplicates.',
      );
    }
    if ((await reservedNames()).has(name)) {
      return fail(
        'name_taken',
        `A tool named "${name}" already exists`,
        'Call list_available_tools to see what exists, then either pick a different name or propose extending the existing tool.',
      );
    }
    if (!description || description.trim() === '') {
      return fail('invalid_argument', 'description is required and must not be empty');
    }
    if (!code || code.trim() === '') {
      return fail('invalid_argument', 'code is required and must not be empty');
    }

    const inputSchema = args['inputSchema'];
    if (typeof inputSchema !== 'object' || inputSchema === null || Array.isArray(inputSchema)) {
      return fail('invalid_argument', 'inputSchema must be a JSON Schema object');
    }

    const capabilities = parseCapabilities(args['capabilities']);
    if (isFailure(capabilities)) return capabilities;

    const networkDomains = Array.isArray(args['networkDomains'])
      ? args['networkDomains'].map((entry) => String(entry))
      : [];
    if (capabilities.includes('net') && networkDomains.length === 0) {
      return fail(
        'invalid_argument',
        'A tool requesting the net capability must list the exact hostnames it needs',
        'Set networkDomains, for example ["api.crossref.org"].',
      );
    }

    const now = Date.now();
    const draft: ToolDef = {
      name,
      title: asString(args, 'title') ?? name,
      description: description.trim(),
      agentDraftDescription: description.trim(),
      inputSchema: inputSchema as JsonSchema,
      code,
      capabilities,
      networkDomains,
      provenance: 'agent',
      descriptionAccepted: false,
      version: 1,
      createdAt: now,
      archivedAt: null,
      stats: { calls: 0, errors: 0, lastUsedAt: null },
      testCases: parseTestCases(args['testCases']),
    };

    const existing = await listTools();
    const overlaps = findOverlaps(draft, [...existing, ...builtinTools]);
    const scanFlags = [...scanDescription(draft.description), ...scanSchema(draft.inputSchema)];

    // Dry-run the model's own test cases immediately, so the user sees real
    // behaviour in the drawer rather than a promise of it.
    const dryRuns: DryRunResult[] = [];
    for (const testCase of draft.testCases.slice(0, 3)) {
      dryRuns.push(await runDraft(draft, testCase.args));
    }

    const proposal: Proposal = {
      id: newId('prop'),
      draft,
      rationale,
      dryRuns,
      scanFlags: scanFlags.map((flag) => `${flag.code}: ${flag.message}`),
      overlapsWith: overlaps.map((overlap) => overlap.name),
      status: 'pending',
      createdAt: now,
    };
    await createProposal(proposal);

    return {
      ok: true,
      proposalId: proposal.id,
      status: 'pending_review',
      registered: false,
      callable: false,
      dryRuns: dryRuns.map((run) => ({ args: run.args, ok: run.ok, error: run.error, ms: run.ms })),
      overlapsWith: proposal.overlapsWith,
      scanFlags: proposal.scanFlags,
      message:
        overlaps.length > 0
          ? `Proposal is waiting for review in the page. It looks similar to ${overlaps
              .map((overlap) => overlap.name)
              .join(', ')}, so the user may choose to extend that instead of adding a new tool. Do not call "${name}" until they confirm they approved it.`
          : `Proposal is waiting for review in the page. Tell the user it is there. Do not call "${name}" until they confirm they approved it.`,
    };
  },
};

function parseTestCases(value: unknown): ToolDef['testCases'] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      args:
        typeof entry['args'] === 'object' && entry['args'] !== null
          ? (entry['args'] as Record<string, unknown>)
          : {},
      expectation: String(entry['expectation'] ?? ''),
    }))
    .slice(0, 5);
}

async function runDraft(draft: ToolDef, args: Record<string, unknown>): Promise<DryRunResult> {
  const outcome = await sandbox.exec({
    toolName: draft.name,
    code: draft.code,
    args,
    capabilities: draft.capabilities,
    networkDomains: draft.networkDomains,
    mode: 'dry',
  });
  return {
    args,
    ok: outcome.ok,
    ...(outcome.ok ? { result: outcome.value } : { error: outcome.error ?? 'failed' }),
    ms: outcome.ms,
  };
}

/* --------------------------------------------------------- dry_run_draft -- */

const dryRunDraftTool: ModelContextTool = {
  name: 'dry_run_draft',
  title: 'Dry-run a proposed tool',
  description:
    'Runs a pending proposal\'s code against the real workspace in dry-run mode and returns what it produced, including any changes it would have made. Nothing is written and nothing is registered. Use this after propose_tool to check your code actually works: if it errors, read the message, then propose a corrected version.',
  inputSchema: {
    type: 'object',
    properties: {
      proposalId: { type: 'string', description: 'The id returned by propose_tool.' },
      args: { type: 'object', description: 'Arguments to call the draft tool with.' },
    },
    required: ['proposalId'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  execute: async (args) => {
    const proposalId = asString(args, 'proposalId');
    if (!proposalId) return fail('invalid_argument', 'proposalId is required');

    const proposal = await getProposal(proposalId);
    if (!proposal) {
      return fail('not_found', `No proposal with id ${proposalId}`, 'Call propose_tool first.');
    }
    if (proposal.status !== 'pending') {
      return fail(
        'not_pending',
        `Proposal ${proposalId} is already ${proposal.status}`,
        proposal.status === 'approved'
          ? `"${proposal.draft.name}" is registered - call it directly.`
          : 'Propose a new version instead.',
      );
    }

    const callArgs =
      typeof args['args'] === 'object' && args['args'] !== null
        ? (args['args'] as Record<string, unknown>)
        : {};

    const result = await runDraft(proposal.draft, callArgs);
    await updateProposal({ ...proposal, dryRuns: [...proposal.dryRuns, result].slice(-10) });

    if (!result.ok) {
      return {
        ok: false,
        error: 'dry_run_failed',
        detail: result.error ?? 'unknown error',
        hint: 'Fix the code and call propose_tool again with a corrected version.',
        ms: result.ms,
      };
    }
    return { ok: true, result: result.result, ms: result.ms, registered: false };
  },
};

/* -------------------------------------------------- list_available_tools -- */

const listAvailableToolsTool: ModelContextTool = {
  name: 'list_available_tools',
  title: 'List the tools this workspace has',
  description:
    'Lists the tools the user has already approved in this workspace, with their descriptions, argument schemas and how often each has been used. Call this before proposing a new tool, to check whether a suitable one already exists, and to match the naming style of what is here.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  execute: async () => {
    const custom = await listTools();
    return {
      builtin: builtinTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        readOnly: tool.annotations?.readOnlyHint === true,
      })),
      custom: custom.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        capabilities: tool.capabilities,
        calls: tool.stats.calls,
        errors: tool.stats.errors,
        lastUsedAt: tool.stats.lastUsedAt ? new Date(tool.stats.lastUsedAt).toISOString() : null,
      })),
      note:
        custom.length === 0
          ? 'No custom tools yet. If the user asks for something they will want again, propose_tool is how it becomes permanent.'
          : undefined,
    };
  },
};

export const metaTools: readonly ModelContextTool[] = Object.freeze([
  listAvailableToolsTool,
  proposeTool,
  dryRunDraftTool,
]);
