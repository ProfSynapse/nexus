/**
 * Location: /src/agents/vaultLibrarian/services/SearchResultFormatter.ts
 * Purpose: Formats search results for directory search operations
 *
 * This service handles transforming search matches into enhanced result objects
 * with metadata, snippets, and type-specific formatting.
 *
 * Used by: SearchDirectoryMode for formatting search results
 * Integrates with: Obsidian Vault API for content access
 *
 * Responsibilities:
 * - Transform matches into DirectoryItem results
 * - Extract content snippets from files
 * - Format file and folder metadata
 */

import { TFile, TFolder } from 'obsidian';

/**
 * Directory item structure for search results (lean format)
 */
export interface DirectoryItem {
  path: string;
  type: 'file' | 'folder';
  snippet?: string;  // For files only
}

/**
 * Match information from search operations
 */
export interface SearchMatch {
  item: TFile | TFolder;
  score: number;
  matchType: string;
}

/**
 * Service for formatting search results
 * Implements Single Responsibility Principle - only handles result formatting
 */
export class SearchResultFormatter {
  private app: any;

  constructor(app: any) {
    this.app = app;
  }

  /**
   * Transform search matches into formatted results
   * @param matches Array of search matches
   * @param includeContent Whether to include content snippets
   * @returns Array of formatted DirectoryItem results
   */
  async transformResults(
    matches: SearchMatch[],
    includeContent: boolean = true
  ): Promise<DirectoryItem[]> {
    const results: DirectoryItem[] = [];

    for (const match of matches) {
      const item = match.item;
      const isFile = item instanceof TFile;

      const result: DirectoryItem = {
        path: item.path,
        type: isFile ? 'file' : 'folder'
      };

      // Add snippet for files if content requested
      if (isFile && includeContent) {
        const snippet = await this.extractSnippet(item as TFile);
        if (snippet) {
          result.snippet = snippet;
        }
      }

      results.push(result);
    }

    return results;
  }

  /**
   * Extract content snippet from a file
   * @param file The file to extract from
   * @returns Content snippet or error message
   */
  private async extractSnippet(file: TFile): Promise<string> {
    try {
      const content = await this.app.vault.read(file);
      const lines = content.split('\n');
      const firstFewLines = lines.slice(0, 3).join(' ');
      return firstFewLines.length > 200
        ? firstFewLines.substring(0, 200) + '...'
        : firstFewLines;
    } catch (error) {
      return 'Content not available';
    }
  }

}
