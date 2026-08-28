import type { Capability } from '../store/types';

/**
 * Message types shared by the host (this origin) and the executor (opaque
 * origin, inside the sandboxed iframe).
 *
 * Everything crossing this boundary is structured-cloned and must survive a
 * JSON round trip: the executor deliberately has no shared realm with us.
 */

/* ------------------------------------------------------ host -> executor --- */

export interface ExecMessage {
  t: 'exec';
  id: number;
  code: string;
  args: Record<string, unknown>;
  capabilities: readonly Capability[];
}

export interface HostResultMessage {
  t: 'hostResult';
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export type ToExecutor = ExecMessage | HostResultMessage;

/**
 * Sent once, as a window message, carrying one end of a MessageChannel. Every
 * later message travels over that port, which the executor keeps in a closure
 * so user code cannot reach it.
 */
export interface InitMessage {
  t: 'init';
  maxHostCalls: number;
}

/* ------------------------------------------------------ executor -> host --- */

export interface ReadyMessage {
  t: 'ready';
}

export interface ExecResultMessage {
  t: 'execResult';
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface HostCallMessage {
  t: 'host';
  id: number;
  /** Which execution is asking. Calls from a finished execution are rejected. */
  exec: number;
  method: string;
  params: unknown;
}

/** Sent as a window message before the port exists, to ask for one. */
export interface BootMessage {
  t: 'boot';
}

export type FromExecutor = ReadyMessage | ExecResultMessage | HostCallMessage;

export function isFromExecutor(value: unknown): value is FromExecutor {
  if (typeof value !== 'object' || value === null) return false;
  const tag = (value as { t?: unknown }).t;
  return tag === 'ready' || tag === 'execResult' || tag === 'host';
}

export function isBootMessage(value: unknown): value is BootMessage {
  return typeof value === 'object' && value !== null && (value as { t?: unknown }).t === 'boot';
}

/* ----------------------------------------------------------------- limits -- */

export const LIMITS = {
  /** Watchdog. Exceeding this destroys and recreates the frame. */
  execTimeoutMs: 3_000,
  /** Time allowed for the frame to say `ready` after being created. */
  bootTimeoutMs: 6_000,
  /** A frame killed mid-loop can take a moment to die; retry the rebuild once. */
  bootAttempts: 2,
  /** Results land in the model's context, so cap them before they get there. */
  maxResultBytes: 64 * 1024,
  /** Network proxy caps. */
  fetchTimeoutMs: 5_000,
  maxFetchBytes: 256 * 1024,
  /** A single tool may not make more host calls than this per execution. */
  maxHostCallsPerExec: 200,
} as const;

/**
 * Where the executor document lives.
 *
 * `sandbox="allow-scripts"` without `allow-same-origin` gives the frame an
 * opaque origin regardless of which host served the file, and the opaque origin
 * is the actual boundary: no access to our IndexedDB, localStorage, cookies or
 * DOM. Serving it from a genuinely separate origin adds defence in depth
 * against a future edit that mistakenly adds `allow-same-origin`, so the URL is
 * configurable: set VITE_SANDBOX_ORIGIN to a second deployment to use one.
 */
const configuredOrigin = import.meta.env['VITE_SANDBOX_ORIGIN'] as string | undefined;

export const EXECUTOR_URL = configuredOrigin
  ? new URL('/sandbox/executor.html', configuredOrigin).toString()
  : '/sandbox/executor.html';

export const EXECUTOR_IS_CROSS_ORIGIN = Boolean(configuredOrigin);

/**
 * The reduced-isolation fallback: a same-origin worker, used only when the
 * browser refuses to run scripts in a src-loaded sandboxed iframe, and only
 * with the user's explicit consent. Served from /sandbox/ so it inherits that
 * path's CSP, which is the only place 'unsafe-eval' is allowed.
 */
export const WORKER_URL = '/sandbox/worker.js';
