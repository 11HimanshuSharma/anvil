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

/**
 * The spec's ToolAnnotations dictionary declares exactly two members. MCP's
 * other hints (destructiveHint, idempotentHint, openWorldHint) are not part of
 * WebMCP and are silently dropped by the WebIDL conversion, so we do not set
 * them: a hint that never reaches the agent is worse than no hint, because it
 * reads in review as though it did.
 */
export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  /** Output is not authored by the site developer. The spec's tool-poisoning mitigation. */
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

/**
 * What `getTools()` hands back. Per the spec this is a `RegisteredTool`: the
 * tool minus its callback, plus the window and origin it was registered from.
 *
 * This object - not the tool's name - is what `executeTool` takes.
 */
export interface ToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema?: JsonSchema;
  readonly annotations?: ToolAnnotations;
  readonly window?: Window;
  readonly origin?: string;
}

export interface RegisterToolOptions {
  readonly signal?: AbortSignal;
}

export interface ExecuteToolOptions {
  readonly signal?: AbortSignal;
}

export interface ModelContextLike extends EventTarget {
  registerTool(tool: ModelContextTool, options?: RegisterToolOptions): Promise<void>;
  getTools(): Promise<readonly ToolDescriptor[]>;
  /**
   * Takes the RegisteredTool from getTools(), not a name, and resolves with a
   * STRING - the JSON-serialised result. Use `callTool` in context.ts rather
   * than calling this directly; it handles the lookup, the argument encoding
   * disagreement between the spec and Chrome's docs, and the parse.
   */
  executeTool(
    tool: ToolDescriptor,
    inputObject?: Record<string, unknown> | string,
    options?: ExecuteToolOptions,
  ): Promise<string | unknown>;
}

export const MODEL_CONTEXT_MODES = ['native', 'native-legacy', 'shim'] as const;
export type ModelContextMode = (typeof MODEL_CONTEXT_MODES)[number];

/** Spec: 1–128 chars, ASCII alphanumerics plus `_`, `-`, `.` */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.\-]{1,128}$/;

export function isToolNameValid(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}
