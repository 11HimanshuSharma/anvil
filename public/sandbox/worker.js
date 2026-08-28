/**
 * Fallback executor: a same-origin Web Worker.
 *
 * READ THIS BEFORE TRUSTING IT. A worker is NOT the equivalent of the opaque
 * origin iframe. A worker runs at the app's own origin, so deleting globals
 * here is the *only* thing between user code and the workspace database - and
 * deleting globals is defence in depth, not a boundary. A determined script can
 * often recover a global; in the iframe it still could not recover an origin.
 *
 * This exists because some embedded browsers refuse to run scripts in a
 * src-loaded sandbox="allow-scripts" iframe. Rather than tell the user their
 * custom tools simply do not work, Anvil offers this and says plainly what it
 * gives up. It is never used without explicit consent.
 */

(() => {
  'use strict';

  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const AsyncFunctionCtor = Object.getPrototypeOf(async function () {}).constructor;
  const post = self.postMessage.bind(self);

  const pending = new Map();
  let seq = 0;
  let activeExec = 0;
  let hostCalls = 0;
  let maxHostCalls = 200;

  // Remove what we can reach. In a worker several of these live on the
  // prototype, so shadow them with undefined when delete will not take.
  for (const key of [
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'Worker',
    'importScripts',
    'indexedDB',
    'caches',
    'EventSource',
    'navigator',
    'BroadcastChannel',
  ]) {
    try {
      delete self[key];
    } catch {
      /* fall through to shadowing */
    }
    if (self[key] !== undefined) {
      try {
        Object.defineProperty(self, key, { value: undefined, configurable: true });
      } catch {
        /* non-configurable; recorded honestly in the UI as reduced isolation */
      }
    }
  }

  function call(method, params) {
    if (hostCalls >= maxHostCalls) {
      return Promise.reject(
        new Error(`host_call_limit: more than ${maxHostCalls} host calls in one execution`),
      );
    }
    hostCalls += 1;
    const exec = activeExec;
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      post({ t: 'host', id, exec, method, params });
    });
  }

  function makeHost(capabilities) {
    const caps = Array.isArray(capabilities) ? capabilities : [];
    const host = {};
    if (caps.includes('read:items')) {
      host.items = {
        list: (query) => call('items.list', query ?? {}),
        get: (id) => call('items.get', id),
      };
    }
    if (caps.includes('write:items')) {
      host.items = Object.assign(host.items ?? {}, {
        upsert: (item) => call('items.upsert', item),
        remove: (id) => call('items.remove', id),
      });
    }
    if (caps.includes('net')) {
      host.fetchJson = (url, init) => call('net.fetch', { url, init });
    }
    host.log = (message) => call('log', String(message));
    if (host.items) Object.freeze(host.items);
    return Object.freeze(host);
  }

  async function runExec(message) {
    activeExec = message.id;
    hostCalls = 0;
    try {
      const fn = new AsyncFunctionCtor('args', 'host', `"use strict";\n${message.code}`);
      const output = await fn(message.args, makeHost(message.capabilities));
      const value = output === undefined ? null : parse(stringify(output) ?? 'null');
      post({ t: 'execResult', id: message.id, ok: true, value });
    } catch (error) {
      post({
        t: 'execResult',
        id: message.id,
        ok: false,
        error: String((error && error.message) || error),
      });
    } finally {
      activeExec = 0;
      for (const [, entry] of pending) entry.reject(new Error('execution_finished'));
      pending.clear();
    }
  }

  self.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;

    if (message.t === 'init') {
      if (typeof message.maxHostCalls === 'number') maxHostCalls = message.maxHostCalls;
      post({ t: 'ready' });
      return;
    }
    if (message.t === 'hostResult') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok) entry.resolve(message.value);
      else entry.reject(new Error(String(message.error)));
      return;
    }
    if (message.t === 'exec') void runExec(message);
  });

  post({ t: 'boot' });
})();
