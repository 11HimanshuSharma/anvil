import type { ModelContextLike, ModelContextTool } from './types';
import { isToolNameValid } from './types';

/**
 * Serialised lifecycle manager for WebMCP tools.
 *
 * Three spec facts drive this design (build plan §3.5):
 *  1. There is no `unregisterTool()` — you abort the signal you registered with.
 *  2. The registration promise RESOLVES once the tool is registered. The
 *     signal's abort steps also reject it, but rejecting an already-settled
 *     promise is a no-op, so the common case is quiet. The `.catch()` below is
 *     for the cases that do reject: an already-aborted signal, and an abort
 *     that lands before registration completes.
 *  3. Unregister/re-register of the same name is an explicitly documented race,
 *     so every mutation goes through one queue.
 */
export class ToolRegistry {
  readonly #mc: ModelContextLike;
  readonly #entries = new Map<string, { ac: AbortController; tool: ModelContextTool }>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(mc: ModelContextLike) {
    this.#mc = mc;
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  register(tool: ModelContextTool): Promise<void> {
    return this.#enqueue(async () => {
      this.#validate(tool);
      const ac = new AbortController();
      const registration = this.#mc.registerTool(tool, { signal: ac.signal });
      // An abort that lands mid-registration rejects this. Swallow it here, at
      // the call site, so it never surfaces as an unhandled rejection.
      registration.catch(() => undefined);
      await registration;
      this.#entries.set(tool.name, { ac, tool });
    });
  }

  unregister(name: string): Promise<void> {
    return this.#enqueue(async () => {
      const entry = this.#entries.get(name);
      if (!entry) return;
      entry.ac.abort(new DOMException(`Unregistered ${name}`, 'AbortError'));
      this.#entries.delete(name);
      await this.#settle();
    });
  }

  async replace(tool: ModelContextTool): Promise<void> {
    await this.unregister(tool.name);
    await this.register(tool);
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  get(name: string): ModelContextTool | undefined {
    return this.#entries.get(name)?.tool;
  }

  names(): readonly string[] {
    return [...this.#entries.keys()];
  }

  #validate(tool: ModelContextTool): void {
    if (!isToolNameValid(tool.name)) {
      throw new Error(
        `Invalid tool name ${JSON.stringify(tool.name)}: expected 1-128 chars of [A-Za-z0-9_.-]`,
      );
    }
    if (!tool.description?.trim()) {
      throw new Error(`Tool "${tool.name}" needs a non-empty description`);
    }
    if (this.#entries.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`);
    }
    try {
      JSON.stringify(tool.inputSchema);
    } catch {
      throw new Error(`Tool "${tool.name}" has a non-serialisable inputSchema`);
    }
  }

  /**
   * `toolchange` fires from a parallel queue, so ordering against our own tasks
   * is not guaranteed. Race it against a short timer so we never hang.
   */
  #settle(): Promise<void> {
    return Promise.race([
      new Promise<void>((resolve) => {
        this.#mc.addEventListener('toolchange', () => resolve(), { once: true });
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 50)),
    ]);
  }
}
