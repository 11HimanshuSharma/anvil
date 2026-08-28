/** Tiny DOM helpers. No framework, by design: see build plan §3.1. */

export function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

export type Child = Node | string | number | null | undefined | false;

export interface Props<K extends keyof HTMLElementTagNameMap> {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
  data?: Record<string, string>;
  on?: {
    [E in keyof HTMLElementEventMap]?: (
      event: HTMLElementEventMap[E],
      target: HTMLElementTagNameMap[K],
    ) => void;
  };
  /** Direct property assignment: value, disabled, checked, selected... */
  props?: Partial<HTMLElementTagNameMap[K]>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props<K> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title !== undefined) node.title = props.title;

  for (const [key, value] of Object.entries(props.attrs ?? {})) {
    node.setAttribute(key, value);
  }
  for (const [key, value] of Object.entries(props.data ?? {})) {
    node.dataset[key] = value;
  }
  for (const [type, handler] of Object.entries(props.on ?? {})) {
    node.addEventListener(type, (event) =>
      (handler as (e: Event, t: HTMLElement) => void)(event, node),
    );
  }
  if (props.props) Object.assign(node, props.props);

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
  }
  return node;
}

/** Replaces a container's contents in one shot. */
export function mount(container: HTMLElement, ...children: Child[]): void {
  container.replaceChildren();
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    container.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
  }
}

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const DAY_MS = 86_400_000;

export function relativeDays(timestamp: number, now: number = Date.now()): string {
  const days = Math.round((timestamp - now) / DAY_MS);
  if (days === 0) return 'today';
  if (Math.abs(days) < 45) return RELATIVE.format(days, 'day');
  return RELATIVE.format(Math.round(days / 30), 'month');
}

/** Strips scheme and trailing slash so a URL reads as a label. */
export function prettyUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
