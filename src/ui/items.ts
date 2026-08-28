import {
  allTags,
  countByStatus,
  listItems,
  onItemsChanged,
  removeItem,
  saveItem,
} from '../store/items';
import { ITEM_STATUSES, type Item, type ItemStatus } from '../store/types';
import { h, mount, prettyUrl, relativeDays } from './dom';

type StatusFilter = ItemStatus | 'all';

interface ViewState {
  status: StatusFilter;
  tag: string | null;
  query: string;
}

const state: ViewState = { status: 'all', tag: null, query: '' };

/** Rows whose updatedAt is this recent get a highlight, so agent edits are visible. */
const FRESH_WINDOW_MS = 6_000;

let container: HTMLElement | null = null;
let addFormOpen = false;

export function mountItemsView(target: HTMLElement): void {
  container = target;
  onItemsChanged(() => void render());
  void render();
}

export async function render(): Promise<void> {
  if (!container) return;

  const [{ items }, tags, counts] = await Promise.all([
    listItems({
      ...(state.status === 'all' ? {} : { status: state.status }),
      ...(state.tag ? { tag: state.tag } : {}),
      limit: 200,
    }),
    allTags(),
    countByStatus(),
  ]);

  const needle = state.query.trim().toLowerCase();
  const visible =
    needle === ''
      ? items
      : items.filter((item) =>
          `${item.title} ${item.url} ${item.notes} ${item.tags.join(' ')}`
            .toLowerCase()
            .includes(needle),
        );

  mount(
    container,
    renderToolbar(counts, tags),
    addFormOpen ? renderAddForm() : null,
    renderList(visible, items.length),
  );
}

/* -------------------------------------------------------------- toolbar ---- */

function renderToolbar(
  counts: Record<ItemStatus, number>,
  tags: { tag: string; count: number }[],
): HTMLElement {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  const statusChips = (['all', ...ITEM_STATUSES] as const).map((status) =>
    h(
      'button',
      {
        class: 'chip',
        data: { active: String(state.status === status) },
        on: {
          click: () => {
            state.status = status;
            void render();
          },
        },
      },
      status,
      h('span', { class: 'chip-count', text: String(status === 'all' ? total : counts[status]) }),
    ),
  );

  const tagSelect = h(
    'select',
    {
      class: 'select',
      on: {
        change: (_event, select) => {
          state.tag = select.value === '' ? null : select.value;
          void render();
        },
      },
    },
    h('option', { text: 'all tags', props: { value: '' } }),
    ...tags.map((entry) =>
      h('option', {
        text: `${entry.tag} (${entry.count})`,
        props: { value: entry.tag, selected: state.tag === entry.tag },
      }),
    ),
  );

  const search = h('input', {
    class: 'input',
    attrs: { type: 'search', placeholder: 'filter…', 'aria-label': 'Filter items' },
    props: { value: state.query },
    on: {
      input: (_event, input) => {
        state.query = input.value;
        void render();
      },
    },
  });

  const addButton = h(
    'button',
    {
      class: 'chip add',
      on: {
        click: () => {
          addFormOpen = !addFormOpen;
          void render();
        },
      },
    },
    addFormOpen ? 'cancel' : '+ add link',
  );

  return h(
    'div',
    { class: 'toolbar' },
    h('div', { class: 'chips-row' }, ...statusChips),
    h('div', { class: 'chips-row' }, tagSelect, search, addButton),
  );
}

function renderAddForm(): HTMLElement {
  const url = h('input', {
    class: 'input grow',
    attrs: { type: 'url', placeholder: 'https://…', required: 'required' },
  });
  const title = h('input', { class: 'input grow', attrs: { placeholder: 'title (optional)' } });
  const tags = h('input', { class: 'input grow', attrs: { placeholder: 'tags, comma, separated' } });

  return h(
    'form',
    {
      class: 'add-form',
      on: {
        submit: (event) => {
          event.preventDefault();
          const value = url.value.trim();
          if (value === '') return;
          void saveItem({
            url: value,
            ...(title.value.trim() === '' ? {} : { title: title.value.trim() }),
            tags: tags.value
              .split(',')
              .map((tag) => tag.trim())
              .filter((tag) => tag !== ''),
          })
            .then(() => {
              addFormOpen = false;
              return render();
            })
            .catch((error: unknown) => {
              window.alert(error instanceof Error ? error.message : String(error));
            });
        },
      },
    },
    url,
    title,
    tags,
    h('button', { class: 'primary', attrs: { type: 'submit' } }, 'save'),
  );
}

/* ----------------------------------------------------------------- list ---- */

function renderList(items: Item[], unfilteredCount: number): HTMLElement {
  if (items.length === 0) {
    return h(
      'p',
      { class: 'empty' },
      unfilteredCount === 0
        ? 'Nothing here yet. Add a link, or ask your agent to save one.'
        : 'No items match that filter.',
    );
  }
  return h('ul', { class: 'items' }, ...items.map(renderItem));
}

function renderItem(item: Item): HTMLElement {
  const fresh = Date.now() - item.updatedAt < FRESH_WINDOW_MS;

  const statusSelect = h(
    'select',
    {
      class: 'status-select',
      data: { status: item.status },
      on: {
        change: (_event, select) => {
          void saveItem({ id: item.id, status: select.value });
        },
      },
    },
    ...ITEM_STATUSES.map((status) =>
      h('option', { text: status, props: { value: status, selected: item.status === status } }),
    ),
  );

  return h(
    'li',
    { class: 'item', data: { fresh: String(fresh) } },
    h(
      'div',
      { class: 'item-main' },
      h(
        'a',
        {
          class: 'item-title',
          attrs: { href: item.url, target: '_blank', rel: 'noreferrer noopener' },
        },
        item.title || prettyUrl(item.url),
      ),
      h('div', { class: 'item-url', text: prettyUrl(item.url) }),
      h(
        'div',
        { class: 'item-meta' },
        h('span', { class: 'source', text: item.source }),
        h('span', { class: 'dot', text: '·' }),
        h('span', { text: relativeDays(item.addedAt) }),
        ...item.tags.map((tag) =>
          h('button', {
            class: 'tag',
            text: tag,
            on: {
              click: () => {
                state.tag = tag;
                void render();
              },
            },
          }),
        ),
      ),
      item.notes.trim() === '' ? null : h('p', { class: 'item-notes', text: item.notes }),
    ),
    h(
      'div',
      { class: 'item-actions' },
      statusSelect,
      h(
        'button',
        {
          class: 'icon danger',
          title: 'delete',
          on: {
            click: () => {
              if (window.confirm(`Delete "${item.title}"?`)) void removeItem(item.id);
            },
          },
        },
        '×',
      ),
    ),
  );
}
