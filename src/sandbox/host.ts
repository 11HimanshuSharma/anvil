import { toToolItem } from '../store/shape';
import { isItemStatus, type Capability } from '../store/types';
import type { ListQuery, SaveItemInput } from '../store/items';
import {
  EXECUTOR_IS_CROSS_ORIGIN,
  EXECUTOR_URL,
  isBootMessage,
  isFromExecutor,
  LIMITS,
  WORKER_URL,
  type ExecMessage,
  type FromExecutor,
  type HostCallMessage,
  type InitMessage,
  type ToExecutor,
} from './protocol';
import { dryRunSession, liveSession, type Mutation, type WorkspaceSession } from './workspace';

/**
 * Parent side of the sandbox.
 *
 * Responsibilities, in rough order of how badly it hurts to get them wrong:
 *  - never trust the capabilities the executor claims; re-check them here
 *  - one execution at a time, with a watchdog that destroys the executor
 *  - cap the result size before it reaches the agent's context
 *  - proxy network access through an exact-hostname allowlist, credential-less
 *
 * Two isolation levels, chosen at runtime:
 *
 *  - `isolated`  an iframe at an OPAQUE ORIGIN. The real boundary.
 *  - `reduced`   a same-origin Web Worker. Used only when the browser refuses
 *                to run scripts in a src-loaded sandboxed iframe (some embedded
 *                browsers do), and only with explicit user consent, because it
 *                is meaningfully weaker and the user deserves to know.
 */

export type IsolationMode = 'isolated' | 'reduced';

export interface SandboxStatus {
  /** The level currently in use, or null before anything has run. */
  mode: IsolationMode | null;
  /** True once the opaque-origin iframe has been proven not to work here. */
  isolatedBlocked: boolean;
  /** Whether the user has accepted the reduced-isolation fallback. */
  reducedConsent: boolean;
  crossOrigin: boolean;
}

export interface ExecRequest {
  toolName: string;
  code: string;
  args: Record<string, unknown>;
  capabilities: readonly Capability[];
  networkDomains: readonly string[];
  mode?: 'live' | 'dry';
}

export interface ExecOutcome {
  ok: boolean;
  value?: unknown;
  error?: string;
  errorCode?: string;
  hint?: string;
  mutations: Mutation[];
  logs: string[];
  ms: number;
}

interface Transport {
  kind: IsolationMode;
  post(message: ToExecutor): void;
  destroy(): void;
}

interface ActiveExec {
  id: number;
  request: ExecRequest;
  session: WorkspaceSession;
  resolve: (outcome: ExecOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
  settled: boolean;
  cleanup: () => void;
}

export class SandboxUnavailableError extends Error {
  readonly code: string;
  constructor(message: string, code = 'sandbox_unavailable') {
    super(message);
    this.name = 'SandboxUnavailableError';
    this.code = code;
  }
}

const CONSENT_KEY = 'anvil.reducedIsolation';

function simulateBlocked(): boolean {
  try {
    return new URLSearchParams(location.search).get('isolation') === 'simulate-blocked';
  } catch {
    return false;
  }
}

function readConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === 'yes';
  } catch {
    return false;
  }
}

class Sandbox {
  #transport: Transport | null = null;
  #booting: Promise<Transport> | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #active: ActiveExec | null = null;
  #execSeq = 0;
  #pendingReady: (() => void) | null = null;

  /**
   * `?isolation=simulate-blocked` pretends the opaque-origin iframe is
   * unavailable, so the fallback path can be exercised in a browser where the
   * iframe actually works. It only simulates the *blockage* - consent is still
   * required, so the worst a stray link can do is show the banner.
   */
  #isolatedBlocked = simulateBlocked();
  #reducedConsent = readConsent();
  readonly #listeners = new Set<(status: SandboxStatus) => void>();

  get status(): SandboxStatus {
    return {
      mode: this.#transport?.kind ?? null,
      isolatedBlocked: this.#isolatedBlocked,
      reducedConsent: this.#reducedConsent,
      crossOrigin: EXECUTOR_IS_CROSS_ORIGIN,
    };
  }

  onStatusChange(listener: (status: SandboxStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #announce(): void {
    const status = this.status;
    for (const listener of this.#listeners) listener(status);
  }

  /** Opt in to the weaker same-origin worker. Only the UI calls this, after saying what it costs. */
  enableReducedIsolation(): void {
    this.#reducedConsent = true;
    try {
      localStorage.setItem(CONSENT_KEY, 'yes');
    } catch {
      /* private mode: consent lasts for this session only */
    }
    this.#booting = null;
    this.#announce();
  }

  /** Warms the executor so the first real call is not paying for boot. */
  async warm(): Promise<void> {
    try {
      await this.#ready();
    } catch {
      // Probing is the point: a failure here sets isolatedBlocked so the UI can
      // offer the fallback before the user hits it mid-demo.
    }
  }

  exec(request: ExecRequest, signal?: AbortSignal): Promise<ExecOutcome> {
    const run = () => this.#run(request, signal);
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Destroys the executor. The next execution rebuilds it. */
  reset(reason = 'reset', errorCode = 'sandbox_destroyed'): void {
    if (this.#active && !this.#active.settled) {
      this.#settle(this.#active, {
        ok: false,
        errorCode,
        error: reason,
        hint: 'The sandbox was torn down mid-execution. Try again.',
      });
    }
    this.#transport?.destroy();
    this.#transport = null;
    this.#booting = null;
    this.#pendingReady = null;
  }

  /* ------------------------------------------------------------- lifecycle */

  #ready(): Promise<Transport> {
    if (this.#transport) return Promise.resolve(this.#transport);
    this.#booting ??= this.#bootBest().catch((error: unknown) => {
      this.#booting = null;
      throw error;
    });
    return this.#booting;
  }

  /**
   * Isolated first, always. The worker is only reachable once the iframe has
   * actually been proven not to work here AND the user has accepted the
   * trade-off - never as a silent convenience.
   */
  async #bootBest(): Promise<Transport> {
    if (!this.#isolatedBlocked) {
      try {
        const transport = await this.#bootWithRetry();
        this.#transport = transport;
        this.#announce();
        return transport;
      } catch (error) {
        this.#isolatedBlocked = true;
        this.#announce();
        if (!this.#reducedConsent) {
          throw new SandboxUnavailableError(
            `This browser did not run the isolated sandbox: ${
              error instanceof Error ? error.message : String(error)
            }`,
            'isolation_blocked',
          );
        }
      }
    }

    if (!this.#reducedConsent) {
      throw new SandboxUnavailableError(
        'The isolated sandbox is unavailable in this browser and reduced isolation has not been enabled.',
        'isolation_blocked',
      );
    }

    const transport = await this.#bootWorker();
    this.#transport = transport;
    this.#announce();
    return transport;
  }

  /**
   * A frame killed mid-`while(true)` does not always die instantly, and its
   * replacement can lose the race to load. One retry turns a hard failure into
   * a slightly slower recovery.
   */
  async #bootWithRetry(): Promise<Transport> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= LIMITS.bootAttempts; attempt += 1) {
      try {
        return await this.#bootIframe();
      } catch (error) {
        lastError = error;
        if (attempt < LIMITS.bootAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new SandboxUnavailableError(String(lastError));
  }

  #bootIframe(): Promise<Transport> {
    return new Promise<Transport>((resolve, reject) => {
      const frame = document.createElement('iframe');
      // No allow-same-origin: that is what makes the origin opaque, and the
      // opaque origin is the actual boundary.
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('aria-hidden', 'true');
      frame.hidden = true;
      frame.style.display = 'none';
      frame.src = EXECUTOR_URL;

      const timer = setTimeout(() => {
        cleanup();
        frame.remove();
        reject(
          new SandboxUnavailableError(
            `the executor frame did not start within ${LIMITS.bootTimeoutMs}ms`,
            'iframe_boot_timeout',
          ),
        );
      }, LIMITS.bootTimeoutMs);

      const onWindowMessage = (event: MessageEvent<unknown>): void => {
        // With allow-scripts only, event.origin serialises as "null", so origin
        // checking is useless here. Identity of the source window is the check.
        if (event.source !== frame.contentWindow) return;
        if (!isBootMessage(event.data)) return;

        const channel = new MessageChannel();
        channel.port1.onmessage = (message: MessageEvent<unknown>) => this.#onInbound(message.data);
        channel.port1.start();

        const init: InitMessage = { t: 'init', maxHostCalls: LIMITS.maxHostCallsPerExec };
        // targetOrigin must be '*': an opaque origin cannot be named.
        frame.contentWindow?.postMessage(init, '*', [channel.port2]);

        this.#pendingReady = () => {
          cleanup();
          resolve({
            kind: 'isolated',
            post: (message) => channel.port1.postMessage(message),
            destroy: () => {
              channel.port1.close();
              frame.remove();
            },
          });
        };
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        window.removeEventListener('message', onWindowMessage);
      };

      window.addEventListener('message', onWindowMessage);
      document.body.append(frame);
    });
  }

  #bootWorker(): Promise<Transport> {
    return new Promise<Transport>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(WORKER_URL);
      } catch (error) {
        reject(
          new SandboxUnavailableError(
            `could not start the fallback worker: ${
              error instanceof Error ? error.message : String(error)
            }`,
            'worker_unavailable',
          ),
        );
        return;
      }

      const timer = setTimeout(() => {
        worker.terminate();
        reject(new SandboxUnavailableError('the fallback worker did not start', 'worker_boot_timeout'));
      }, LIMITS.bootTimeoutMs);

      worker.onerror = () => {
        clearTimeout(timer);
        worker.terminate();
        reject(new SandboxUnavailableError('the fallback worker failed to load', 'worker_unavailable'));
      };

      worker.onmessage = (event: MessageEvent<unknown>) => {
        const data = event.data;
        if (isBootMessage(data)) {
          const init: InitMessage = { t: 'init', maxHostCalls: LIMITS.maxHostCallsPerExec };
          worker.postMessage(init);
          return;
        }
        if (typeof data === 'object' && data !== null && (data as { t?: unknown }).t === 'ready') {
          clearTimeout(timer);
          resolve({
            kind: 'reduced',
            post: (message) => worker.postMessage(message),
            // Unlike an iframe, a worker really can be terminated.
            destroy: () => worker.terminate(),
          });
          return;
        }
        this.#onInbound(data);
      };
    });
  }

  /* --------------------------------------------------------------- execute */

  async #run(request: ExecRequest, signal?: AbortSignal): Promise<ExecOutcome> {
    const startedAt = performance.now();

    if (signal?.aborted) {
      return failure('aborted', 'Execution was cancelled before it started', startedAt);
    }

    let transport: Transport;
    try {
      transport = await this.#ready();
    } catch (error) {
      const code = error instanceof SandboxUnavailableError ? error.code : 'sandbox_unavailable';
      return failure(
        code,
        error instanceof Error ? error.message : String(error),
        startedAt,
        code === 'isolation_blocked'
          ? 'This browser blocks the isolated sandbox. Open the page in Chrome, or enable reduced isolation from the banner at the top of the workspace.'
          : 'The sandbox could not start. Check that /sandbox/executor.html is being served.',
      );
    }

    const id = ++this.#execSeq;
    const session = request.mode === 'dry' ? dryRunSession() : liveSession();

    return new Promise<ExecOutcome>((resolve) => {
      // The watchdog. An iframe cannot be terminated, so the kill switch is to
      // remove it from the DOM; a worker gets a real terminate().
      const timer = setTimeout(() => {
        this.reset(
          `execution exceeded ${LIMITS.execTimeoutMs}ms and the sandbox was destroyed`,
          'timeout',
        );
      }, LIMITS.execTimeoutMs);

      const onAbort = (): void => {
        this.reset('cancelled by the agent', 'aborted');
      };
      signal?.addEventListener('abort', onAbort);

      const active: ActiveExec = {
        id,
        request,
        session,
        resolve,
        timer,
        startedAt,
        settled: false,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      };
      this.#active = active;

      const message: ExecMessage = {
        t: 'exec',
        id,
        code: request.code,
        args: request.args,
        capabilities: request.capabilities,
      };
      transport.post(message);
    });
  }

  #settle(active: ActiveExec, partial: Omit<ExecOutcome, 'mutations' | 'logs' | 'ms'>): void {
    if (active.settled) return;
    active.settled = true;
    clearTimeout(active.timer);
    active.cleanup();
    if (this.#active === active) this.#active = null;
    active.resolve({
      ...partial,
      mutations: active.session.mutations,
      logs: active.session.logs,
      ms: Math.round(performance.now() - active.startedAt),
    });
  }

  /* -------------------------------------------------------- executor inbox */

  #onInbound(data: unknown): void {
    if (!isFromExecutor(data)) return;
    const message: FromExecutor = data;

    if (message.t === 'ready') {
      const pending = this.#pendingReady;
      this.#pendingReady = null;
      pending?.();
      return;
    }

    if (message.t === 'execResult') {
      const active = this.#active;
      if (!active || active.id !== message.id) return;
      if (!message.ok) {
        this.#settle(active, {
          ok: false,
          errorCode: 'execution_failed',
          error: String(message.error ?? 'unknown error'),
        });
        return;
      }
      const capped = capResult(message.value);
      if (!capped.ok) {
        this.#settle(active, {
          ok: false,
          errorCode: 'result_too_large',
          error: capped.error,
          hint: 'Return a summary or a smaller page of results; the value goes into the model context.',
        });
        return;
      }
      this.#settle(active, { ok: true, value: capped.value });
      return;
    }

    void this.#onHostCall(message);
  }

  async #onHostCall(message: HostCallMessage): Promise<void> {
    const transport = this.#transport;
    if (!transport) return;
    const active = this.#active;

    const reply = (ok: boolean, payload: { value?: unknown; error?: string }): void => {
      transport.post({ t: 'hostResult', id: message.id, ok, ...payload });
    };

    // A call from a finished execution is either a bug or an attempt to reuse a
    // stale `host` object under someone else's capabilities.
    if (!active || active.settled || active.id !== message.exec) {
      reply(false, { error: 'stale_execution: this execution is no longer active' });
      return;
    }

    try {
      const value = await this.#dispatch(message.method, message.params, active);
      reply(true, { value });
    } catch (error) {
      reply(false, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Capability checks happen HERE, against what the user granted - never against what the executor claims. */
  async #dispatch(method: string, params: unknown, active: ActiveExec): Promise<unknown> {
    const { capabilities, networkDomains, toolName } = active.request;
    const requires = (capability: Capability): void => {
      if (!capabilities.includes(capability)) {
        throw new Error(
          `capability_denied: "${toolName}" did not declare "${capability}", so host.${method} is unavailable`,
        );
      }
    };

    switch (method) {
      // Items cross into the sandbox in exactly the shape the built-in tools
      // return, so a tool the agent writes sees one consistent world.
      case 'items.list': {
        requires('read:items');
        return (await active.session.list(asListQuery(params))).map(toToolItem);
      }
      case 'items.get': {
        requires('read:items');
        const item = await active.session.get(String(params));
        return item === null ? null : toToolItem(item);
      }
      case 'items.upsert': {
        requires('write:items');
        return toToolItem(await active.session.upsert(asSaveInput(params)));
      }
      case 'items.remove': {
        requires('write:items');
        return active.session.remove(String(params));
      }
      case 'net.fetch': {
        requires('net');
        return fetchJson(params, networkDomains);
      }
      case 'log': {
        active.session.log(String(params));
        return null;
      }
      default:
        throw new Error(`unknown_host_method: ${method}`);
    }
  }
}

/* ------------------------------------------------------------- validation -- */

function asListQuery(params: unknown): ListQuery {
  if (typeof params !== 'object' || params === null) return {};
  const raw = params as Record<string, unknown>;
  const query: ListQuery = {};
  if (isItemStatus(raw['status'])) query.status = raw['status'];
  if (typeof raw['tag'] === 'string') query.tag = raw['tag'];
  if (typeof raw['source'] === 'string') query.source = raw['source'];
  if (typeof raw['limit'] === 'number') query.limit = raw['limit'];
  if (typeof raw['offset'] === 'number') query.offset = raw['offset'];
  return query;
}

function asSaveInput(params: unknown): SaveItemInput {
  if (typeof params !== 'object' || params === null) {
    throw new Error('invalid_argument: host.items.upsert expects an object');
  }
  const raw = params as Record<string, unknown>;
  const input: SaveItemInput = {};
  if (typeof raw['id'] === 'string') input.id = raw['id'];
  if (typeof raw['url'] === 'string') input.url = raw['url'];
  if (typeof raw['title'] === 'string') input.title = raw['title'];
  if (typeof raw['source'] === 'string') input.source = raw['source'];
  if (Array.isArray(raw['tags'])) input.tags = raw['tags'].map((tag) => String(tag));
  if (typeof raw['status'] === 'string') input.status = raw['status'];
  if (typeof raw['notes'] === 'string') input.notes = raw['notes'];
  return input;
}

/* ---------------------------------------------------------- network proxy -- */

async function fetchJson(params: unknown, allowed: readonly string[]): Promise<unknown> {
  if (typeof params !== 'object' || params === null) {
    throw new Error('invalid_argument: host.fetchJson expects (url, init)');
  }
  const raw = params as { url?: unknown; init?: unknown };
  const url = new URL(String(raw.url));

  const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !isLoopback) {
    throw new Error(`network_denied: only https is allowed (got ${url.protocol})`);
  }
  if (!allowed.includes(url.hostname)) {
    throw new Error(
      `network_denied: ${url.hostname} is not in this tool's allowlist [${allowed.join(', ') || 'empty'}]`,
    );
  }

  const init = (typeof raw.init === 'object' && raw.init !== null ? raw.init : {}) as RequestInit;

  let response: Response;
  try {
    response = await fetch(url, {
      method: typeof init.method === 'string' ? init.method : 'GET',
      headers: { accept: 'application/json' },
      body: init.body ?? null,
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      mode: 'cors',
      cache: 'no-store',
      signal: AbortSignal.timeout(LIMITS.fetchTimeoutMs),
    });
  } catch (error) {
    // The proxy runs on the app's own origin, so the deployment's `connect-src`
    // is an outer bound the per-tool allowlist cannot widen. Say that, instead
    // of surfacing a bare "Failed to fetch" the agent cannot act on.
    throw new Error(
      `network_failed: could not reach ${url.hostname} (${
        error instanceof Error ? error.message : String(error)
      }). Two usual causes: this deployment's Content-Security-Policy connect-src does not list ` +
        `${url.hostname}, so the browser blocks the request before it leaves; or the host does not ` +
        `send CORS headers for this origin.`,
    );
  }

  const text = await readCapped(response, LIMITS.maxFetchBytes);
  try {
    return { status: response.status, json: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, text };
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`response_too_large: over ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/* -------------------------------------------------------------- result cap - */

function capResult(value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  let serialised: string;
  try {
    serialised = JSON.stringify(value ?? null) ?? 'null';
  } catch {
    return { ok: false, error: 'result was not JSON-serialisable' };
  }
  if (serialised.length > LIMITS.maxResultBytes) {
    return {
      ok: false,
      error: `result is ${serialised.length} bytes, over the ${LIMITS.maxResultBytes} byte cap`,
    };
  }
  return { ok: true, value };
}

function failure(code: string, message: string, startedAt: number, hint?: string): ExecOutcome {
  return {
    ok: false,
    errorCode: code,
    error: message,
    ...(hint === undefined ? {} : { hint }),
    mutations: [],
    logs: [],
    ms: Math.round(performance.now() - startedAt),
  };
}

export const sandbox = new Sandbox();
export type { Mutation, FromExecutor };
