/**
 * FileContentService - LLM-specific file content gathering
 *
 * Thin wrapper around VaultOperations for LLM-specific file content formatting.
 * This service handles:
 * - Parallel file reading via VaultOperations
 * - Formatting file content with path headers for LLM context
 * - Error handling and graceful degradation
 */

import { VaultOperations } from '../../../core/VaultOperations';

/**
 * Interface for file content gathering operations
 */
export interface IFileContentService {
  /**
   * Gather and format file content for LLM context
   * @param filepaths - Array of file paths to read
   * @returns Formatted string with file headers and content
   */
  gatherFileContent(filepaths: string[]): Promise<string>;
}

/**
 * FileContentService implementation
 * Uses VaultOperations for cached, parallel file reading
 */
export class FileContentService implements IFileContentService {
  constructor(private vaultOperations: VaultOperations) {}

  /**
   * Gather and format file content from multiple paths
   *
   * Uses VaultOperations.batchRead() for parallel, cached reads
   * Formats content with file path headers for LLM context
   *
   * Format:
   * ```
   * --- path/to/file1.md ---
   * [file content]
   *
   * --- path/to/file2.md ---
   * [file content or error message]
   * ```
   */
  async gatherFileContent(filepaths: string[]): Promise<string> {
    if (filepaths.length === 0) {
      return '';
    }

    // Use VaultOperations.batchRead() for parallel, cached reads
    const contentMap = await this.vaultOperations.batchRead(filepaths);

    // Format content with file headers
    const contentParts: string[] = [];

    for (const filepath of filepaths) {
      const content = contentMap.get(filepath);

      if (content !== null && content !== undefined) {
        // File read successfully
        contentParts.push(`--- ${filepath} ---\n${content}\n`);
      } else {
        // File read failed (null from VaultOperations)
        contentParts.push(`--- ${filepath} ---\n[Error: File not found or could not be read]\n`);
      }
    }

    return contentParts.join('\n');
  }

  /**
   * Format files as XML blocks (for advanced system prompts)
   * Used by ModelAgentManager for structured context
   *
   * Format:
   * ```xml
   * <file_path_to_file1_md>
   * path/to/file1.md
   *
   * [content]
   * </file_path_to_file1_md>
   * ```
   */
  async formatAsXml(filepaths: string[]): Promise<string> {
    if (filepaths.length === 0) {
      return '';
    }

    const contentMap = await this.vaultOperations.batchRead(filepaths);
    const xmlParts: string[] = [];

    for (const filepath of filepaths) {
      const content = contentMap.get(filepath);
      const xmlTag = this.normalizePathToXmlTag(filepath);

      if (content !== null && content !== undefined) {
        xmlParts.push(`<${xmlTag}>\n${filepath}\n\n${content}\n</${xmlTag}>\n`);
      } else {
        xmlParts.push(`<${xmlTag}>\n${filepath}\n\n[Error: File not found]\n</${xmlTag}>\n`);
      }
    }

    return xmlParts.join('\n');
  }

  /**
   * Convert file path to valid XML tag name
   * Example: "path/to/file.md" -> "file_path_to_file_md"
   */
  private normalizePathToXmlTag(path: string): string {
    return path
      .replace(/[^a-zA-Z0-9_]/g, '_')  // Replace non-alphanumeric with underscore
      .replace(/^_+|_+$/g, '')          // Remove leading/trailing underscores
      .replace(/__+/g, '_')             // Replace multiple underscores with single
      .toLowerCase();
  }
}
