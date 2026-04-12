import { JSONSchema } from '../../types/schema/JSONSchemaTypes';

/**
 * Tense used when rendering a tool status label.
 * - `present` — action in progress ("Reading foo.md")
 * - `past`    — action completed ("Read foo.md")
 * - `failed`  — action failed ("Failed to read foo.md")
 */
export type ToolStatusTense = 'present' | 'past' | 'failed';

/**
 * Interface for tools in the MCP plugin
 * Each tool provides a specific functionality within an agent's domain
 */
export interface ITool<T = unknown, R = unknown> {
  /**
   * Slug of the tool (used for identification)
   */
  slug: string;

  /**
   * Name of the tool
   */
  name: string;

  /**
   * Description of the tool
   */
  description: string;

  /**
   * Version of the tool
   */
  version: string;

  /**
   * Execute the tool with parameters
   * @param params Parameters for the tool
   * @returns Promise that resolves with the tool's result
   */
  execute(params: T): Promise<R>;

  /**
   * Get the JSON schema for the tool's parameters
   * @returns JSON schema object
   */
  getParameterSchema(): JSONSchema;

  /**
   * Get the JSON schema for the tool's result
   * @returns JSON schema object
   */
  getResultSchema(): JSONSchema;

  /**
   * Optional: produce a human-readable, parameter-aware status label for
   * the ToolStatusBar. Return `undefined` to fall back to the generic
   * label derived from `name` ("Running <name>" / "Ran <name>" / ...).
   *
   * Tools that benefit from parameter interpolation (e.g. "Reading foo.md",
   * "Creating task \"ship MVP\"") should override this method. See
   * `BaseTool.getStatusLabel` for the default no-op implementation.
   *
   * @param params Tool execution parameters
   * @param tense Grammatical tense to render ('present' | 'past' | 'failed')
   * @returns Status label string, or undefined to use fallback
   */
  getStatusLabel?(
    params: Record<string, unknown> | undefined,
    tense: ToolStatusTense
  ): string | undefined;
}
