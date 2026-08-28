import type {
  ExecuteToolOptions,
  ModelContextLike,
  ModelContextTool,
  RegisterToolOptions,
  ToolDescriptor,
} from './types';
import { isToolNameValid } from './types';

/**
 * A local `ModelContext` implementation for browsers without WebMCP.
 *
 * It exists so that:
 *  - the in-page "Run" button exercises the real code path (`getTools()` then
 *    `executeTool()`) rather than calling the JS function directly, and
 *  - the app is fully usable in stock Safari/Firefox.
 *
 * It mirrors the spec's observable behaviour on purpose: duplicate or empty
 * names reject with `InvalidStateError`, aborting the registration signal
 * unregisters the tool and rejects the original `registerTool` promise, and
 * `toolchange` is dispatched from a task queue rather than synchronously.
 */
class ModelContextShim extends EventTarget implements ModelContextLike {
  readonly #tools = new Map<string, ModelContextTool>();

  registerTool(tool: ModelContextTool, options?: RegisterToolOptions): Promise<void> {
    const signal = options?.signal;

    if (!tool.name || !isToolNameValid(tool.name)) {
      return Promise.reject(
        new DOMException(`Invalid tool name: ${JSON.stringify(tool.name)}`, 'InvalidStateError'),
      );
    }
    if (!tool.description) {
      return Promise.reject(
        new DOMException(`Tool "${tool.name}" needs a description`, 'InvalidStateError'),
      );
    }
    if (this.#tools.has(tool.name)) {
      return Promise.reject(
        new DOMException(`Tool "${tool.name}" is already registered`, 'InvalidStateError'),
      );
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }

    this.#tools.set(tool.name, tool);
    this.#scheduleToolChange();

    return new Promise<void>((resolve, reject) => {
      // The spec's abort steps unregister the tool and reject this promise.
      // Once it has resolved that rejection is a no-op, which is why the
      // common unregister path is quiet rather than noisy.
      signal?.addEventListener(
        'abort',
        () => {
          if (this.#tools.get(tool.name) === tool) {
            this.#tools.delete(tool.name);
            this.#scheduleToolChange();
          }
          reject(signal.reason);
        },
        { once: true },
      );
      // Registration is complete: resolve, as the spec requires. An earlier
      // version left this pending on the theory that the promise settled only
      // on abort - which is what made `await registerTool(...)` hang.
      resolve();
    });
  }

  getTools(): Promise<readonly ToolDescriptor[]> {
    const descriptors = [...this.#tools.values()].map(toDescriptor);
    return Promise.resolve(Object.freeze(descriptors));
  }

  /**
   * Mirrors the spec exactly: takes the RegisteredTool from `getTools()` - not
   * a name - and resolves with a STRING.
   *
   * Getting this wrong is how a shim stops being a test of what ships. An
   * earlier version here took a name and returned an object, so every in-page
   * call passed locally and would have thrown in Chrome and ChatGPT.
   */
  async executeTool(
    tool: ToolDescriptor,
    inputObject: Record<string, unknown> | string = {},
    options: ExecuteToolOptions = {},
  ): Promise<string> {
    if (typeof tool !== 'object' || tool === null || typeof tool.name !== 'string') {
      throw new TypeError('executeTool expects the RegisteredTool from getTools(), not a tool name');
    }
    const registered = this.#tools.get(tool.name);
    if (!registered) {
      throw new DOMException(`No such tool: ${tool.name}`, 'NotFoundError');
    }

    // The spec's IDL says `object inputObject`; Chrome's documentation passes a
    // JSON string. Accept both rather than betting on one.
    const args: Record<string, unknown> =
      typeof inputObject === 'string'
        ? (JSON.parse(inputObject || '{}') as Record<string, unknown>)
        : inputObject;

    const controller = new AbortController();
    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), {
        once: true,
      });
    }
    const result = await registered.execute(args, { signal: controller.signal });
    // Results are JSON-serialised for transmission, so a non-serialisable
    // return fails here rather than silently in the agent.
    return JSON.stringify(result ?? null) ?? 'null';
  }

  /**
   * `toolchange` fires from a parallel queue in the spec; ordering relative to
   * other tasks is not guaranteed. Deferring here keeps shim and native
   * behaviour comparable instead of accidentally-synchronous.
   */
  #scheduleToolChange(): void {
    setTimeout(() => this.dispatchEvent(new Event('toolchange')), 0);
  }
}

function toDescriptor(tool: ModelContextTool): ToolDescriptor {
  const { execute: _execute, ...descriptor } = tool;
  return descriptor;
}

export function createShim(): ModelContextLike {
  return new ModelContextShim();
}
