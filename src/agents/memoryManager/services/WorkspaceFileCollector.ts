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
   * @returns Workspace path result with files list
   */
  async buildWorkspacePath(
    rootFolder: string,
    app: App
  ): Promise<WorkspacePathResult> {
    try {
      const folder = app.vault.getAbstractFileByPath(rootFolder);

      if (!folder || !(folder instanceof TFolder)) {
        console.warn('[WorkspaceFileCollector] Workspace root folder not found or empty:', rootFolder);
        return { path: { folder: rootFolder, files: [] }, failed: true };
      }

      // Collect all files recursively with relative paths
      const files = this.collectAllFiles(folder, rootFolder);

      return {
        path: {
          folder: rootFolder,
          files: files
        },
        failed: false
      };

    } catch (error) {
      console.warn('[WorkspaceFileCollector] Failed to build workspace path:', error);
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
        console.warn('[WorkspaceFileCollector] CacheManager not available for recent files');
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
      console.warn('[WorkspaceFileCollector] Failed to get recent files:', error);
      return [];
    }
  }
}
