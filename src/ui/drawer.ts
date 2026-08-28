import { summariseMutations, type MutationSummary } from '../sandbox/diff';
import { sandbox } from '../sandbox/host';
import { getProposal, onProposalsChanged, pendingProposals, updateProposal } from '../store/proposals';
import { putTool } from '../store/tools';
import type { Capability, Proposal, ToolDef } from '../store/types';
import { contextCost } from '../surface/entropy';
import { toModelContextTool } from '../tools/custom';
import type { ToolRegistry } from '../webmcp/registry';
import { h, mount, prettyUrl } from './dom';

/**
 * The review drawer.
 *
 * Deliberately NOT "here are 40 lines of JavaScript, approve?". That is
 * security theatre: the audience who cannot stand up an MCP server cannot audit
 * JavaScript either. The order below is the argument:
 *
 *   1. what it can touch      - capability chips
 *   2. what it actually did   - a dry run against real items, as a diff
 *   3. the words you own      - the description, editable, flagged as agent-authored
 *   4. the source             - collapsed, for the few who want it
 */

const CAPABILITY_LABEL: Readonly<Record<Capability, string>> = Object.freeze({
  'read:items': 'reads your items',
  'write:items': 'writes your items',
  net: 'reaches the network',
});

let registry: ToolRegistry;
let root: HTMLElement;
let current: Proposal | null = null;

/**
 * The description the human is part-way through writing.
 *
 * The drawer re-renders whenever its proposal changes - which includes the
 * user's own "run again" - so the in-progress edit has to survive that. Losing
 * it silently would be the worst possible place for a data-loss bug: owning the
 * wording is the whole security argument.
 */
let editedDescription: string | null = null;
let editedFor: string | null = null;
/** How many other proposals are still waiting behind this one. */
let queued = 0;

export function mountDrawer(target: HTMLElement, toolRegistry: ToolRegistry): void {
  root = target;
  registry = toolRegistry;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'false');
  root.setAttribute('aria-label', 'Review a proposed tool');

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && current) {
      event.preventDefault();
      close();
    }
  });

  onProposalsChanged(({ kind, proposal }) => {
    // A newly arrived proposal must NOT steal the drawer from one being
    // reviewed: that would throw away a half-written description. It queues,
    // and the "N more waiting" line says so.
    if (current && current.id !== proposal.id) {
      void refreshQueuedCount();
      return;
    }
    if (kind === 'created' && proposal.status === 'pending') void open(proposal.id);
    else if (current && current.id === proposal.id) void open(proposal.id);
  });

  // A proposal made in a previous session is still waiting.
  void pendingProposals().then((pending) => {
    const first = pending[0];
    if (first) void open(first.id);
  });
}

export async function open(proposalId: string): Promise<void> {
  const proposal = await getProposal(proposalId);
  if (!proposal || proposal.status !== 'pending') {
    await openNextPending();
    return;
  }
  const firstOpen = current?.id !== proposal.id;
  current = proposal;
  queued = (await pendingProposals()).filter((entry) => entry.id !== proposal.id).length;
  render(proposal);
  root.dataset['open'] = 'true';
  // Move focus in only when the drawer first appears, never on a re-render:
  // stealing it mid-edit would be worse than not managing focus at all.
  if (firstOpen) root.querySelector('h2')?.setAttribute('tabindex', '-1');
  if (firstOpen) (root.querySelector('h2') as HTMLElement | null)?.focus();
}

async function refreshQueuedCount(): Promise<void> {
  const openId = current?.id;
  if (!openId) return;
  queued = (await pendingProposals()).filter((entry) => entry.id !== openId).length;
  const line = root.querySelector('.drawer-queued');
  const text = `${queued} more proposal${queued === 1 ? '' : 's'} waiting behind this one.`;
  if (line) line.textContent = text;
  else if (queued > 0) root.querySelector('.drawer-head')?.append(h('p', { class: 'drawer-queued', text }));
}

/** Proposals can queue up. Resolving one should reveal the next, not hide it. */
async function openNextPending(): Promise<void> {
  const pending = await pendingProposals();
  const next = pending.find((entry) => entry.id !== current?.id);
  if (next) {
    current = null;
    await open(next.id);
    return;
  }
  close();
}

export function close(): void {
  current = null;
  editedDescription = null;
  editedFor = null;
  root.dataset['open'] = 'false';
  mount(root);
}

/* --------------------------------------------------------------- render --- */

function render(proposal: Proposal): void {
  const draft = proposal.draft;
  if (editedFor !== proposal.id) {
    editedDescription = null;
    editedFor = proposal.id;
  }

  const active = document.activeElement;
  const hadFocus = active instanceof HTMLElement && active.classList.contains('drawer-description');
  const caret = hadFocus ? (active as HTMLTextAreaElement).selectionStart : null;

  const descriptionField = h('textarea', {
    class: 'drawer-description',
    attrs: { rows: '5', 'aria-label': 'Tool description' },
    props: { value: editedDescription ?? draft.description },
    on: {
      input: (_event, field) => {
        editedDescription = field.value;
        editedFor = proposal.id;
      },
    },
  });

  mount(
    root,
    h(
      'div',
      { class: 'drawer-panel' },
      renderHeader(proposal),
      proposal.overlapsWith.length > 0 ? renderOverlap(proposal) : null,
      renderCapabilities(draft),
      renderDryRuns(proposal),
      renderDescription(draft, descriptionField),
      renderScanFlags(proposal),
      renderSource(draft),
      renderActions(proposal, descriptionField),
    ),
  );

  if (hadFocus) {
    descriptionField.focus();
    if (caret !== null) descriptionField.setSelectionRange(caret, caret);
  }
}

function renderHeader(proposal: Proposal): HTMLElement {
  return h(
    'header',
    { class: 'drawer-head' },
    h(
      'div',
      {},
      h('h2', { class: 'drawer-title', text: proposal.draft.title || proposal.draft.name }),
      h('code', { class: 'drawer-name', text: proposal.draft.name }),
    ),
    h(
      'button',
      { class: 'icon', title: 'dismiss (Esc)', attrs: { 'aria-label': 'Dismiss' }, on: { click: () => close() } },
      '×',
    ),
    h('p', { class: 'drawer-rationale', text: proposal.rationale }),
    queued > 0
      ? h('p', {
          class: 'drawer-queued',
          text: `${queued} more proposal${queued === 1 ? '' : 's'} waiting behind this one.`,
        })
      : null,
  );
}

function renderOverlap(proposal: Proposal): HTMLElement {
  const names = proposal.overlapsWith.join(', ');
  return h(
    'section',
    { class: 'drawer-section warn' },
    h('h3', { class: 'drawer-label', text: 'Looks like a tool you already have' }),
    h('p', {
      class: 'drawer-note',
      text: `This overlaps ${names}. Two tools that do nearly the same thing make your agent worse at picking between them, and both cost context every session. Extending the existing one is usually the better move.`,
    }),
    h(
      'button',
      {
        class: 'primary',
        on: {
          click: (_event, button) => {
            const prompt = `The tool you proposed overlaps ${names}. Instead of adding a new tool, propose an updated version of ${proposal.overlapsWith[0]} that takes an extra parameter to cover this case.`;
            void navigator.clipboard.writeText(prompt).then(() => {
              button.textContent = 'copied - paste it to your agent';
            });
          },
        },
      },
      `Extend ${proposal.overlapsWith[0]} instead`,
    ),
  );
}

function renderCapabilities(draft: ToolDef): HTMLElement {
  const chips =
    draft.capabilities.length === 0
      ? [h('li', { class: 'cap ok', text: 'pure computation - touches nothing' })]
      : draft.capabilities.map((capability) =>
          h('li', {
            class: `cap ${capability === 'read:items' ? 'ok' : 'warn'}`,
            text:
              capability === 'net'
                ? `${CAPABILITY_LABEL[capability]}: ${draft.networkDomains.join(', ') || 'no hosts listed'}`
                : CAPABILITY_LABEL[capability],
          }),
        );

  return h(
    'section',
    { class: 'drawer-section' },
    h('h3', { class: 'drawer-label', text: 'What it can touch' }),
    h('ul', { class: 'caps' }, ...chips),
  );
}

function renderDryRuns(proposal: Proposal): HTMLElement {
  const runs = proposal.dryRuns.slice(-3);
  const body =
    runs.length === 0
      ? [h('p', { class: 'drawer-note', text: 'No dry run yet.' })]
      : runs.map((run, index) =>
          h(
            'div',
            { class: 'dryrun', data: { ok: String(run.ok) } },
            h('div', { class: 'dryrun-head' }, h('code', { text: `call ${index + 1}: ${JSON.stringify(run.args)}` }), h('span', { class: 'dryrun-ms', text: `${run.ms}ms` })),
            run.ok
              ? renderMutationDiff(run.mutations)
              : h('p', { class: 'dryrun-err', text: run.error ?? 'failed' }),
            run.ok
              ? h(
                  'details',
                  { class: 'dryrun-raw' },
                  h('summary', { text: 'raw return value' }),
                  h('pre', { class: 'dryrun-out', text: preview(run.result) }),
                )
              : null,
          ),
        );

  return h(
    'section',
    { class: 'drawer-section' },
    h(
      'h3',
      { class: 'drawer-label' },
      'What it actually did',
      h('span', { class: 'drawer-hint', text: 'against your real items, nothing written' }),
    ),
    ...body,
    h(
      'button',
      {
        class: 'ghost',
        on: {
          click: (_event, button) => {
            button.disabled = true;
            button.textContent = 'running…';
            void rerun(proposal).finally(() => {
              button.disabled = false;
              button.textContent = 'run again';
            });
          },
        },
      },
      'run again',
    ),
  );
}

async function rerun(proposal: Proposal): Promise<void> {
  const args = proposal.draft.testCases[0]?.args ?? {};
  const outcome = await sandbox.exec({
    toolName: proposal.draft.name,
    code: proposal.draft.code,
    args,
    capabilities: proposal.draft.capabilities,
    networkDomains: proposal.draft.networkDomains,
    mode: 'dry',
  });
  const fresh = await getProposal(proposal.id);
  if (!fresh) return;
  await updateProposal({
    ...fresh,
    dryRuns: [
      ...fresh.dryRuns,
      {
        args,
        ok: outcome.ok,
        ...(outcome.ok ? { result: outcome.value } : { error: outcome.error ?? 'failed' }),
        mutations: summariseMutations(outcome.mutations),
        logs: outcome.logs,
        ms: outcome.ms,
      },
    ].slice(-10),
  });
}

/** The before/after view. This is what someone is actually approving. */
function renderMutationDiff(mutations: readonly MutationSummary[]): HTMLElement {
  if (mutations.length === 0) {
    return h('p', { class: 'diff-none', text: 'Changed nothing. Read-only for these arguments.' });
  }

  const shown = mutations.slice(0, 6);
  return h(
    'div',
    { class: 'diff-list' },
    h('p', {
      class: 'diff-count',
      text: `Would change ${mutations.length} item${mutations.length === 1 ? '' : 's'}:`,
    }),
    ...shown.map((mutation) =>
      h(
        'div',
        { class: 'diff-row', data: { kind: mutation.kind } },
        h('span', { class: 'diff-mark', text: MARK[mutation.kind] }),
        h(
          'span',
          { class: 'diff-body' },
          h('span', { class: 'diff-title', text: mutation.title }),
          ...mutation.changes.map((change) =>
            h(
              'span',
              { class: 'diff-change' },
              h('span', { class: 'diff-field', text: change.field }),
              h('span', { class: 'diff-before', text: shorten(change.before) || '(empty)' }),
              ' → ',
              h('span', { class: 'diff-after', text: shorten(change.after) || '(empty)' }),
            ),
          ),
        ),
      ),
    ),
    mutations.length > shown.length
      ? h('p', { class: 'diff-count', text: `and ${mutations.length - shown.length} more` })
      : null,
  );
}

const MARK: Readonly<Record<MutationSummary['kind'], string>> = Object.freeze({
  create: '+',
  update: '~',
  remove: '-',
});

/**
 * Elides the MIDDLE, not the tail.
 *
 * Truncating the tail made the diff useless for the most common change there
 * is - stripping a query string - because both halves ended in the same
 * ellipsis and the only difference was the part that got cut.
 */
function shorten(value: string): string {
  const cleaned = value.startsWith('http') ? prettyUrl(value) : value;
  if (cleaned.length <= 52) return cleaned;
  return `${cleaned.slice(0, 24)}…${cleaned.slice(-26)}`;
}

function preview(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  return text.length > 900 ? `${text.slice(0, 900)}\n… (${text.length} chars)` : text;
}

function renderDescription(draft: ToolDef, field: HTMLTextAreaElement): HTMLElement {
  return h(
    'section',
    { class: 'drawer-section' },
    h(
      'h3',
      { class: 'drawer-label' },
      'The description you are committing to',
      h('span', { class: 'drawer-hint', text: 'drafted by the agent - edit freely' }),
    ),
    h('p', {
      class: 'drawer-note',
      text: 'This text is loaded into the model context in every future session, which is exactly why a model may not write it unread. It is the steering, not the code.',
    }),
    field,
    h('p', {
      class: 'drawer-note',
      text: `Costs about ${contextCost(draft)} tokens of your agent's context, every turn.`,
    }),
  );
}

function renderScanFlags(proposal: Proposal): HTMLElement | null {
  if (proposal.scanFlags.length === 0) return null;
  return h(
    'section',
    { class: 'drawer-section warn' },
    h('h3', { class: 'drawer-label', text: 'Worth a second read' }),
    h(
      'ul',
      { class: 'caps' },
      ...proposal.scanFlags.map((flag) => h('li', { class: 'cap warn', text: flag })),
    ),
  );
}

function renderSource(draft: ToolDef): HTMLElement {
  return h(
    'details',
    { class: 'drawer-source' },
    h('summary', { text: `Source (${draft.code.split('\n').length} lines)` }),
    h('pre', { text: draft.code }),
  );
}

function renderActions(proposal: Proposal, field: HTMLTextAreaElement): HTMLElement {
  const status = h('p', { class: 'drawer-status' });

  const approve = h(
    'button',
    {
      class: proposal.overlapsWith.length > 0 ? 'ghost' : 'primary',
      on: {
        click: (_event, button) => {
          const accepted = field.value.trim();
          if (accepted === '') {
            status.textContent = 'A tool needs a description before it can be registered.';
            return;
          }
          button.disabled = true;
          void approveProposal(proposal, accepted)
            .then(() => openNextPending())
            .catch((error: unknown) => {
              button.disabled = false;
              status.textContent = error instanceof Error ? error.message : String(error);
            });
        },
      },
    },
    proposal.overlapsWith.length > 0 ? 'Approve as a new tool anyway' : 'Approve and register',
  );

  const reject = h(
    'button',
    {
      class: 'ghost danger',
      on: {
        click: () => {
          void updateProposal({ ...proposal, status: 'rejected' }).then(() => openNextPending());
        },
      },
    },
    'Reject',
  );

  return h('footer', { class: 'drawer-actions' }, approve, reject, status);
}

/* -------------------------------------------------------------- approve --- */

async function approveProposal(proposal: Proposal, acceptedDescription: string): Promise<void> {
  const def: ToolDef = {
    ...proposal.draft,
    description: acceptedDescription,
    // The gate. Nothing else in the codebase sets this to true.
    descriptionAccepted: true,
  };

  await putTool(def);
  await registry.register(toModelContextTool(def));
  await updateProposal({ ...proposal, draft: def, status: 'approved' });
}
