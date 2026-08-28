import { onAuditChanged, recent } from '../store/audit';
import type { AuditEntry } from '../store/types';
import { h, mount } from './dom';

let container: HTMLElement | null = null;

export function mountAuditLog(target: HTMLElement): void {
  container = target;
  onAuditChanged(() => void render());
  void render();
}

export async function render(): Promise<void> {
  if (!container) return;
  const entries = await recent(40);
  if (entries.length === 0) {
    mount(container, h('li', { class: 'empty', text: 'No tool calls yet.' }));
    return;
  }
  mount(container, ...entries.map(renderEntry));
}

function argSummary(args: Record<string, unknown>): string {
  const parts = Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${shorten(value)}`);
  return parts.join(' ');
}

function shorten(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > 28 ? `${text.slice(0, 27)}…` : text;
}

function renderEntry(entry: AuditEntry): HTMLElement {
  return h(
    'li',
    { class: 'audit', data: { ok: String(entry.ok) } },
    h('span', {
      class: 't',
      text: new Date(entry.ts).toLocaleTimeString('en-GB', { hour12: false }),
    }),
    h(
      'span',
      { class: 'm' },
      h('span', { class: 'audit-name', text: entry.toolName }),
      ' ',
      h('span', { class: 'audit-args', text: argSummary(entry.args) }),
      entry.error ? h('span', { class: 'audit-error', text: ` ${entry.error}` }) : null,
    ),
    h('span', { class: 'audit-ms', text: `${entry.durationMs}ms` }),
  );
}
