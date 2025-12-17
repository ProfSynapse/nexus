import { App, TFolder } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { CommonParameters, CommonResult } from '../../../types';

/**
 * Base class for directory listing operations
 * Provides common functionality for tools that work with directories
 */
export abstract class BaseDirectoryTool<T extends CommonParameters, R extends CommonResult> extends BaseTool<T, R> {
  protected app: App;

  constructor(slug: string, name: string, description: string, version: string, app: App) {
    super(slug, name, description, version);
    this.app = app;
  }

  /**
   * Normalize directory path by removing leading slash and handling special cases for root
   * @param path Path to normalize
   * @returns Normalized path (empty string for root)
   */
  protected normalizeDirectoryPath(path: string): string {
    // Handle special cases for root directory
    if (!path || path === '/' || path === '.') {
      return '';
    }
    // Remove leading slash if present
    return path.startsWith('/') ? path.slice(1) : path;
  }

  /**
   * Get a folder from the vault by path
   * @param path Directory path (normalized or not)
   * @returns TFolder instance
   * @throws Error if folder not found
   */
  protected async getFolder(path: string): Promise<TFolder> {
    const normalizedPath = this.normalizeDirectoryPath(path);

    // Handle root directory case
    if (normalizedPath === '') {
      return this.app.vault.getRoot();
    }

    // Get folder by path - use getAbstractFileByPath for folders
    const folder = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!folder || !(folder instanceof TFolder)) {
      // Double check by looking at the exact path without any modifications
      throw new Error(`Folder not found at path: ${normalizedPath}`);
    }

    return folder;
  }

  /**
   * Get standardized directory path schema for JSON schema
   * @returns Schema object for directory path parameter
   */
  protected getDirectoryPathSchema(): any {
    return {
      type: 'string',
      description: 'Directory path (required). Use empty string (""), "/" or "." for root directory',
      default: ''
    };
  }

  /**
   * Generate helpful message for root directory operations
   * @param normalizedPath The normalized path (empty string indicates root)
   * @param operationType Type of operation being performed
   * @returns Helpful message or undefined
   */
  protected getRootDirectoryMessage(normalizedPath: string, operationType: string): string | undefined {
    if (normalizedPath === '') {
      return `${operationType} in root directory only. This may not include all items in the vault - many may be organized in subfolders. Use listFolders tool to explore the full vault structure.`;
    }
    return undefined;
  }
}
