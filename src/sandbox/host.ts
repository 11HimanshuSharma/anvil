import { isItemStatus, type Capability } from '../store/types';
import type { ListQuery, SaveItemInput } from '../store/items';
import {
  EXECUTOR_IS_CROSS_ORIGIN,
  EXECUTOR_URL,
  isBootMessage,
  isFromExecutor,
  LIMITS,
  type ExecMessage,
  type FromExecutor,
  type HostCallMessage,
  type InitMessage,
} from './protocol';
import { dryRunSession, liveSession, type Mutation, type WorkspaceSession } from './workspace';

/**
 * Parent side of the sandbox.
 *
 * Responsibilities, in rough order of how badly it hurts to get them wrong:
 *  - never trust the capabilities the frame claims; re-check them here
 *  - one execution at a time, with a watchdog that destroys the frame on timeout
 *    (you cannot terminate an iframe, you remove it from the DOM)
 *  - cap the result size before it reaches the agent's context
 *  - proxy network access through an exact-hostname allowlist, credential-less
 */

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

interface ActiveExec {
  id: number;
  request: ExecRequest;
  session: WorkspaceSession;
  resolve: (outcome: ExecOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  startedAt: number;
  settled: boolean;
  /** Detaches the abort listener so a later abort cannot reset an unrelated run. */
  cleanup: () => void;
}

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxUnavailableError';
  }
}

class Sandbox {
  #frame: HTMLIFrameElement | null = null;
  #port: MessagePort | null = null;
  #booting: Promise<MessagePort> | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #active: ActiveExec | null = null;
  #execSeq = 0;

  get crossOrigin(): boolean {
    return EXECUTOR_IS_CROSS_ORIGIN;
  }

  /** Warms the frame so the first real call is not paying for boot. */
  async warm(): Promise<void> {
    await this.#ready();
  }

  exec(request: ExecRequest, signal?: AbortSignal): Promise<ExecOutcome> {
    const run = () => this.#run(request, signal);
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Destroys the frame. The next execution rebuilds it. */
  reset(reason = 'reset', errorCode = 'sandbox_destroyed'): void {
    if (this.#active && !this.#active.settled) {
      this.#settle(this.#active, {
        ok: false,
        errorCode,
        error: reason,
        hint: 'The sandbox was torn down mid-execution. Try again.',
      });
    }
    this.#port?.close();
    this.#port = null;
    this.#booting = null;
    this.#frame?.remove();
    this.#frame = null;
  }

  /* ------------------------------------------------------------- lifecycle */

  #ready(): Promise<MessagePort> {
    if (this.#port) return Promise.resolve(this.#port);
    this.#booting ??= this.#bootWithRetry().catch((error: unknown) => {
      this.#booting = null;
      throw error;
    });
    return this.#booting;
  }

  /**
   * A frame killed mid-`while(true)` does not always die instantly, and its
   * replacement can lose the race to load. One retry turns a hard failure into
   * a slightly slower recovery.
   */
  async #bootWithRetry(): Promise<MessagePort> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= LIMITS.bootAttempts; attempt += 1) {
      try {
        return await this.#boot();
      } catch (error) {
        lastError = error;
        this.#frame?.remove();
        this.#frame = null;
        if (attempt < LIMITS.bootAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new SandboxUnavailableError(String(lastError));
  }

  #boot(): Promise<MessagePort> {
    return new Promise<MessagePort>((resolve, reject) => {
      const frame = document.createElement('iframe');
      // No allow-same-origin: that is what makes the origin opaque, and the
      // opaque origin is the actual boundary.
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('aria-hidden', 'true');
      frame.hidden = true;
      frame.style.display = 'none';
      frame.src = EXECUTOR_URL;
      this.#frame = frame;

      const timer = setTimeout(() => {
        cleanup();
        this.reset('boot timeout');
        reject(new SandboxUnavailableError(`Executor did not boot within ${LIMITS.bootTimeoutMs}ms`));
      }, LIMITS.bootTimeoutMs);

      const onWindowMessage = (event: MessageEvent<unknown>): void => {
        // With allow-scripts only, event.origin serialises as "null", so origin
        // checking is useless here. Identity of the source window is the check.
        if (event.source !== frame.contentWindow) return;
        if (!isBootMessage(event.data)) return;

        const channel = new MessageChannel();
        channel.port1.onmessage = (message: MessageEvent<unknown>) => this.#onPortMessage(message);
        channel.port1.start();

        const init: InitMessage = { t: 'init', maxHostCalls: LIMITS.maxHostCallsPerExec };
        // targetOrigin must be '*': an opaque origin cannot be named.
        frame.contentWindow?.postMessage(init, '*', [channel.port2]);
        this.#pendingReady = () => {
          cleanup();
          this.#port = channel.port1;
          resolve(channel.port1);
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

  #pendingReady: (() => void) | null = null;

  /* --------------------------------------------------------------- execute */

  async #run(request: ExecRequest, signal?: AbortSignal): Promise<ExecOutcome> {
    const startedAt = performance.now();

    if (signal?.aborted) {
      return failure('aborted', 'Execution was cancelled before it started', startedAt);
    }

    let port: MessagePort;
    try {
      port = await this.#ready();
    } catch (error) {
      return failure(
        'sandbox_unavailable',
        error instanceof Error ? error.message : String(error),
        startedAt,
        'The sandboxed iframe could not start. Check that /sandbox/executor.html is being served.',
      );
    }

    const id = ++this.#execSeq;
    const session = request.mode === 'dry' ? dryRunSession() : liveSession();

    return new Promise<ExecOutcome>((resolve) => {
      // The watchdog. You cannot terminate an iframe, so the kill switch is to
      // remove it from the DOM; the next execution rebuilds it.
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
      port.postMessage(message);
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

  /* ------------------------------------------------------------ port inbox */

  #onPortMessage(event: MessageEvent<unknown>): void {
    const message = event.data;
    if (!isFromExecutor(message)) return;

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
    const port = this.#port;
    if (!port) return;
    const active = this.#active;

    const reply = (ok: boolean, payload: { value?: unknown; error?: string }): void => {
      port.postMessage({ t: 'hostResult', id: message.id, ok, ...payload });
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

  /** Capability checks happen HERE, against what the user granted - never against what the frame claims. */
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
      case 'items.list': {
        requires('read:items');
        return active.session.list(asListQuery(params));
      }
      case 'items.get': {
        requires('read:items');
        return active.session.get(String(params));
      }
      case 'items.upsert': {
        requires('write:items');
        return active.session.upsert(asSaveInput(params));
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

  if (url.protocol !== 'https:') {
    throw new Error(`network_denied: only https is allowed (got ${url.protocol})`);
  }
  if (!allowed.includes(url.hostname)) {
    throw new Error(
      `network_denied: ${url.hostname} is not in this tool's allowlist [${allowed.join(', ') || 'empty'}]`,
    );
  }

  const init = (typeof raw.init === 'object' && raw.init !== null ? raw.init : {}) as RequestInit;
  const response = await fetch(url, {
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
