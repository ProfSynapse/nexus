/**
 * Location: /src/agents/searchManager/services/DirectoryItemCollector.ts
 * Purpose: Collects files and folders from directories
 *
 * This service handles recursive collection of files and folders from
 * specified directory paths with depth control and type filtering.
 *
 * Used by: SearchDirectoryMode for collecting search candidates
 * Integrates with: Obsidian Vault API
 *
 * Responsibilities:
 * - Collect files and/or folders from directory paths
 * - Handle recursive directory traversal with depth limits
 * - Filter by search type (files, folders, or both)
 */

import { Plugin, TFile, TFolder, TAbstractFile } from 'obsidian';
import { isGlobPattern, globToRegex } from '../../../utils/pathUtils';

/**
 * Service for collecting directory items
 * Implements Single Responsibility Principle - only handles item collection
 */
export class DirectoryItemCollector {
  private plugin: Plugin;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
  }

  /**
   * Get items from specified directory paths
   * @param paths Directory paths to collect from
   * @param searchType Type of items to collect
   * @param maxDepth Optional maximum depth for recursion
   * @returns Array of collected items
   */
  async getDirectoryItems(
    paths: string[],
    searchType: 'files' | 'folders' | 'both',
    maxDepth?: number
  ): Promise<(TFile | TFolder)[]> {
    const allItems: (TFile | TFolder)[] = [];

    for (const path of paths) {
      const normalizedPath = this.normalizePath(path);

      if (isGlobPattern(normalizedPath)) {
        // Handle glob pattern
        const regex = globToRegex(normalizedPath);
        const vaultItems = this.plugin.app.vault.getAllLoadedFiles();
        
        for (const item of vaultItems) {
          // Skip root folder itself if it comes up
          if (item.path === '/') continue;

          if (regex.test(item.path)) {
             if (this.matchesSearchType(item, searchType)) {
                allItems.push(item as TFile | TFolder);
             }
          }
        }
      } else if (normalizedPath === '/' || normalizedPath === '') {
        // Root path - get all vault items
        const vaultItems = this.plugin.app.vault.getAllLoadedFiles()
          .filter(file => this.matchesSearchType(file, searchType)) as (TFile | TFolder)[];
        allItems.push(...vaultItems);
      } else {
        // Specific directory
        const directoryItems = await this.getItemsInDirectory(
          normalizedPath,
          searchType,
          maxDepth
        );
        allItems.push(...directoryItems);
      }
    }

    // Remove duplicates
    return Array.from(new Map(allItems.map(item => [item.path, item])).values());
  }

  /**
   * Get items from a specific directory with optional depth limit
   * @param directoryPath The directory path
   * @param searchType Type of items to collect
   * @param maxDepth Optional maximum depth
   * @returns Array of collected items
   */
  private async getItemsInDirectory(
    directoryPath: string,
    searchType: 'files' | 'folders' | 'both',
    maxDepth?: number
  ): Promise<(TFile | TFolder)[]> {
    const folder = this.plugin.app.vault.getAbstractFileByPath(directoryPath);

    if (!folder || !('children' in folder)) {
      return [];
    }

    const items: (TFile | TFolder)[] = [];

    const collectItems = (currentFolder: TFolder, currentDepth: number = 0) => {
      if (maxDepth !== undefined && currentDepth >= maxDepth) {
        return;
      }

      for (const child of currentFolder.children) {
        if (this.matchesSearchType(child, searchType)) {
          items.push(child as TFile | TFolder);
        }

        // Recursive traversal for folders
        if ('children' in child) {
          collectItems(child as TFolder, currentDepth + 1);
        }
      }
    };

    collectItems(folder as TFolder);
    return items;
  }

  /**
   * Check if an item matches the search type filter
   * @param item The item to check
   * @param searchType The search type filter
   * @returns True if item matches the filter
   */
  private matchesSearchType(
    item: TAbstractFile,
    searchType: 'files' | 'folders' | 'both'
  ): boolean {
    switch (searchType) {
      case 'files':
        return item instanceof TFile;
      case 'folders':
        return item instanceof TFolder;
      case 'both':
      default:
        return item instanceof TFile || item instanceof TFolder;
    }
  }

  /**
   * Normalize a path for consistent handling
   * @param path The path to normalize
   * @returns Normalized path
   */
  private normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  }
}
