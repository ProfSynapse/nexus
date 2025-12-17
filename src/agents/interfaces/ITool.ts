/**
 * Interface for tools in the MCP plugin
 * Each tool provides a specific functionality within an agent's domain
 */
export interface ITool<T = any, R = any> {
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
  getParameterSchema(): any;

  /**
   * Get the JSON schema for the tool's result
   * @returns JSON schema object
   */
  getResultSchema(): any;
}
