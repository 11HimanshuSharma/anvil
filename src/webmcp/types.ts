/**
 * Minimal typings for the WebMCP surface we depend on.
 *
 * The shipped IDL (Chromium 149+) exposes `document.modelContext`; some builds
 * still carry the deprecated `navigator.modelContext`. There is deliberately no
 * `unregisterTool()` — you unregister by aborting the signal you passed to
 * `registerTool`. See build plan §3.5 / §11.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON Schema object. Not modelled structurally on purpose. */
export type JsonSchema = Record<string, unknown>;

export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
  /** Output is not authored by the site developer. Spec's mitigation for tool poisoning. */
  readonly untrustedContentHint?: boolean;
}

export interface ToolExecuteCallbackOptions {
  readonly signal?: AbortSignal;
}

export interface ModelContextTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations?: ToolAnnotations;
  readonly execute: (
    args: Record<string, unknown>,
    options: ToolExecuteCallbackOptions,
  ) => unknown | Promise<unknown>;
}

/** What `getTools()` hands back: the tool minus its `execute` callback. */
export type ToolDescriptor = Omit<ModelContextTool, 'execute'>;

export interface RegisterToolOptions {
  readonly signal?: AbortSignal;
}

export interface ModelContextLike extends EventTarget {
  registerTool(tool: ModelContextTool, options?: RegisterToolOptions): Promise<void>;
  getTools(): Promise<readonly ToolDescriptor[]>;
  executeTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

export const MODEL_CONTEXT_MODES = ['native', 'native-legacy', 'shim'] as const;
export type ModelContextMode = (typeof MODEL_CONTEXT_MODES)[number];

/** Spec: 1–128 chars, ASCII alphanumerics plus `_`, `-`, `.` */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.\-]{1,128}$/;

export function isToolNameValid(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}
