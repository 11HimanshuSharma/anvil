import { sandbox, type SandboxStatus } from '../sandbox/host';
import { h, mount } from './dom';

/**
 * Tells the truth about where user code is running.
 *
 * Some embedded browsers refuse to run scripts in a src-loaded
 * sandbox="allow-scripts" iframe. When that happens the honest options are to
 * break, or to offer something weaker and say exactly what is weaker about it.
 * Silently downgrading the security boundary would be the one unacceptable
 * choice, so the fallback needs a click and this banner is where it happens.
 */

let root: HTMLElement | null = null;

export function mountIsolationBanner(target: HTMLElement): void {
  root = target;
  sandbox.onStatusChange((status) => render(status));
  render(sandbox.status);
}

function render(status: SandboxStatus): void {
  if (!root) return;

  if (status.isolatedBlocked && !status.reducedConsent) {
    root.dataset['state'] = 'blocked';
    mount(
      root,
      h(
        'div',
        { class: 'isolation blocked' },
        h('strong', { text: 'This browser blocked the isolated sandbox.' }),
        h('p', {
          text:
            'Anvil runs tool code in an iframe at an opaque origin, which cannot reach your saved items, ' +
            'cookies or storage. This browser will not run scripts there, so custom tools cannot execute.',
        }),
        h('p', {
          class: 'isolation-choice',
          text:
            'You can open the page in Chrome to get the real boundary, or fall back to a same-origin ' +
            'Web Worker. The worker is weaker: it runs on this origin, so removing its access to ' +
            'IndexedDB and fetch is a precaution rather than a boundary. Built-in tools are unaffected either way.',
        }),
        h(
          'button',
          {
            class: 'primary',
            on: {
              click: () => {
                sandbox.enableReducedIsolation();
                void sandbox.warm();
              },
            },
          },
          'Run tools with reduced isolation',
        ),
      ),
    );
    return;
  }

  if (status.mode === 'reduced') {
    root.dataset['state'] = 'reduced';
    mount(
      root,
      h(
        'div',
        { class: 'isolation reduced' },
        h('strong', { text: 'Reduced isolation.' }),
        ' Tool code is running in a same-origin worker because this browser blocked the ' +
          'opaque-origin iframe. Capability checks still apply, but the origin boundary does not.',
      ),
    );
    return;
  }

  root.dataset['state'] = 'ok';
  mount(root);
}
