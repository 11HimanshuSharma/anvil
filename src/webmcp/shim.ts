import type {
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

    // Spec quirk: the registration promise settles only when the tool goes
    // away. Callers must attach a `.catch()` immediately (see registry.ts).
    return new Promise<void>((_resolve, reject) => {
      if (!signal) return; // never unregistered; promise stays pending, as in the spec
      signal.addEventListener(
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
    });
  }

  getTools(): Promise<readonly ToolDescriptor[]> {
    const descriptors = [...this.#tools.values()].map(toDescriptor);
    return Promise.resolve(Object.freeze(descriptors));
  }

  async executeTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const tool = this.#tools.get(name);
    if (!tool) {
      throw new DOMException(`No such tool: ${name}`, 'NotFoundError');
    }
    const controller = new AbortController();
    const result = await tool.execute(args, { signal: controller.signal });
    // The real implementation JSON-serialises results; do the same so a
    // non-serialisable return value fails here rather than silently in ChatGPT.
    return JSON.parse(JSON.stringify(result ?? null)) as unknown;
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
