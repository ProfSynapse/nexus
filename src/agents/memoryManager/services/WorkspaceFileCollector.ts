/**
 * Location: /src/agents/memoryManager/services/WorkspaceFileCollector.ts
 * Purpose: Collects and organizes workspace files
 *
 * This service handles building workspace file structures and collecting
 * recently modified files from the cache.
 *
 * Used by: LoadWorkspaceMode for file structure and recent files
 * Integrates with: Obsidian Vault API and CacheManager
 *
 * Responsibilities:
 * - Build workspace path structure with all files
 * - Collect all files recursively from folders
 * - Get recently modified files in workspace
 */

import { App, TFolder, TAbstractFile, TFile } from 'obsidian';

/**
 * Interface for workspace data
 */
interface IWorkspaceData {
  rootFolder: string;
}

/**
 * Interface for cache manager
 */
interface ICacheManager {
  getRecentFiles(limit: number, folder: string): Array<{ path: string; modified: number }> | null;
}

/**
 * Workspace path structure with files list
 */
export interface WorkspacePath {
  folder: string;
  files: string[];
}

/**
 * Result of workspace path building
 */
export interface WorkspacePathResult {
  path: WorkspacePath;
  failed: boolean;
}

/**
 * Recent file information
 */
export interface RecentFileInfo {
  path: string;
  modified: number;
}

/**
 * Service for collecting and organizing workspace files
 * Implements Single Responsibility Principle - only handles file operations
 */
export class WorkspaceFileCollector {
  /**
   * Build workspace path with folder path and flat files list
   * @param rootFolder The workspace root folder path
   * @param app The Obsidian app instance
   * @param recursive Whether to collect files recursively (true) or top-level only (false, default)
   * @returns Workspace path result with files list
   */
  async buildWorkspacePath(
    rootFolder: string,
    app: App,
    recursive: boolean = false
  ): Promise<WorkspacePathResult> {
    try {
      const folder = app.vault.getAbstractFileByPath(rootFolder);

      if (!folder || !(folder instanceof TFolder)) {
        return { path: { folder: rootFolder, files: [] }, failed: true };
      }

      // Collect files based on recursive flag
      const files = recursive
        ? this.collectAllFiles(folder, rootFolder)
        : this.collectTopLevel(folder);

      return {
        path: {
          folder: rootFolder,
          files: files
        },
        failed: false
      };

    } catch (error) {
      return { path: { folder: rootFolder, files: [] }, failed: true };
    }
  }

  /**
   * Collect all files recursively as flat list with relative paths
   * @param folder The folder to collect from
   * @param basePath The base path for relative path calculation
   * @returns Array of relative file paths
   */
  collectAllFiles(folder: TFolder, basePath: string): string[] {
    const files: string[] = [];

    if (!folder.children) {
      return files;
    }

    for (const child of folder.children) {
      if (child instanceof TFolder) {
        // It's a folder - recurse into it
        const subFiles = this.collectAllFiles(child, basePath);
        files.push(...subFiles);
      } else {
        // It's a file - add with relative path from base
        const relativePath = child.path.replace(basePath + '/', '');
        files.push(relativePath);
      }
    }

    return files.sort();
  }

  /**
   * Collect top-level items only (folders marked with trailing /, files as-is)
   * @param folder The folder to collect from
   * @returns Array of top-level item names (folders have trailing /)
   */
  collectTopLevel(folder: TFolder): string[] {
    const items: string[] = [];

    if (!folder.children) {
      return items;
    }

    for (const child of folder.children) {
      if (child instanceof TFolder) {
        // Mark folders with trailing /
        items.push(child.name + '/');
      } else {
        // Files just use their name
        items.push(child.name);
      }
    }

    return items.sort();
  }

  /**
   * Get recently modified files in workspace folder
   * @param workspace The workspace object
   * @param cacheManager The cache manager instance
   * @returns Array of recent file info
   */
  async getRecentFilesInWorkspace(
    workspace: IWorkspaceData,
    cacheManager: ICacheManager | null
  ): Promise<RecentFileInfo[]> {
    try {
      if (!cacheManager) {
        return [];
      }

      const recentFiles = cacheManager.getRecentFiles(5, workspace.rootFolder);

      if (!recentFiles || recentFiles.length === 0) {
        return [];
      }

      // Map IndexedFile[] to simple {path, modified} objects
      return recentFiles.map((file) => ({
        path: file.path,
        modified: file.modified
      }));

    } catch (error) {
      return [];
    }
  }
}
