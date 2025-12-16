/**
 * VaultOperations - Centralized Vault operations using official Obsidian API
 * Location: src/core/VaultOperations.ts
 * 
 * This service replaces all Node.js filesystem operations with Obsidian Vault API calls,
 * ensuring cross-platform compatibility (mobile + desktop) and proper integration
 * with Obsidian's caching and file management systems.
 * 
 * Used by:
 * - All services that need file/directory operations
 * - ChromaDB persistence operations
 * - Plugin data management
 * - Configuration file handling
 */

import { Vault, TFile, TFolder, normalizePath } from 'obsidian';
import { ObsidianPathManager } from './ObsidianPathManager';
import { StructuredLogger } from './StructuredLogger';

export interface BatchWriteOperation {
  path: string;
  content: string;
}

export interface BatchWriteResult {
  success: string[];
  failed: string[];
}

export interface FileStats {
  size: number;
  mtime: number;
  ctime: number;
  type: 'file' | 'folder';
}

/**
 * Centralized Vault operations using official Obsidian API
 * Replaces all Node.js filesystem operations
 */
export class VaultOperations {
  private fileCache = new Map<string, { content: string; mtime: number }>();

  constructor(
    private vault: Vault,
    private pathManager: ObsidianPathManager,
    private logger: StructuredLogger
  ) {}

  /**
   * Get file by path with proper error handling
   */
  async getFile(path: string): Promise<TFile | null> {
    try {
      const normalizedPath = this.pathManager.normalizePath(path);
      const file = this.vault.getFileByPath(normalizedPath);
      return file;
    } catch (error) {
      this.logger.warn(`Failed to get file: ${path}`, error);
      return null;
    }
  }

  /**
   * Get folder by path with proper error handling
   */
  async getFolder(path: string): Promise<TFolder | null> {
    try {
      const normalizedPath = this.pathManager.normalizePath(path);
      const folder = this.vault.getFolderByPath(normalizedPath);
      return folder;
    } catch (error) {
      this.logger.warn(`Failed to get folder: ${path}`, error);
      return null;
    }
  }

  /**
   * Check if file exists
   */
  async fileExists(path: string): Promise<boolean> {
    try {
      const normalizedPath = this.pathManager.normalizePath(path);
      return await this.vault.adapter.exists(normalizedPath);
    } catch (error) {
      this.logger.debug(`File existence check failed: ${path}`, error);
      return false;
    }
  }

  /**
   * Check if folder exists
   */
  async folderExists(path: string): Promise<boolean> {
    try {
      const normalizedPath = this.pathManager.normalizePath(path);
      const stat = await this.vault.adapter.stat(normalizedPath);
      return stat?.type === 'folder';
    } catch (error) {
      this.logger.debug(`Folder existence check failed: ${path}`, error);
      return false;
    }
  }

  /**
   * Check if path is hidden (starts with . in any segment)
   */
  private isHiddenPath(path: string): boolean {
    return path.split('/').some(segment => segment.startsWith('.'));
  }

  /**
   * Read file content with caching support
   * Uses adapter.read() for hidden files since Obsidian doesn't index them
   */
  async readFile(path: string, useCache: boolean = true): Promise<string | null> {
    try {
      const normalizedPath = this.pathManager.normalizePath(path);

      // For hidden files, use adapter directly (Obsidian doesn't index hidden files)
      if (this.isHiddenPath(normalizedPath)) {
        const exists = await this.vault.adapter.exists(normalizedPath);
        if (!exists) {
          this.logger.warn(`File not found: ${normalizedPath}`);
          return null;
        }
        const content = await this.vault.adapter.read(normalizedPath);
        this.logger.debug(`Successfully read hidden file: ${normalizedPath}`);
        return content;
      }

      if (useCache) {
        const file = await this.getFile(normalizedPath);
        if (file) {
          const cached = this.fileCache.get(normalizedPath);
          if (cached && cached.mtime === file.stat.mtime) {
            this.logger.debug(`Cache hit for file: ${normalizedPath}`);
            return cached.content;
          }
        }
      }

      const file = await this.getFile(normalizedPath);
      if (!file) {
        this.logger.warn(`File not found: ${normalizedPath}`);
        return null;
      }

      const content = await this.vault.cachedRead(file);

      if (useCache) {
        this.fileCache.set(normalizedPath, {
          content,
          mtime: file.stat.mtime
        });
      }

      this.logger.debug(`Successfully read file: ${normalizedPath}`);
      return content;
    } catch (error) {
      this.logger.error(`Failed to read file ${path}`, error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  /**
   * Write file content with automatic directory creation
   * Uses adapter.write() for hidden files since Obsidian doesn't index them
   */
  async writeFile(path: string, content: string): Promise<boolean> {
    try {
      const normalizedPath = this.pathManager.normalizePath(path);

      // For hidden files, use adapter directly (Obsidian doesn't index hidden files)
      if (this.isHiddenPath(normalizedPath)) {
        // Ensure parent directory exists using adapter
        const parentPath = this.pathManager.getParentPath(normalizedPath);
        if (parentPath) {
          const parentExists = await this.vault.adapter.exists(parentPath);
          if (!parentExists) {
            await this.vault.adapter.mkdir(parentPath);
          }
        }
        await this.vault.adapter.write(normalizedPath, content);
        this.logger.debug(`Successfully wrote hidden file: ${normalizedPath}`);
        return true;
      }

      await this.pathManager.ensureParentExists(normalizedPath);

      const existingFile = await this.getFile(normalizedPath);
      if (existingFile) {
        await this.vault.modify(existingFile, content);
      } else {
        await this.vault.create(normalizedPath, content);
      }

      // Invalidate cache
      this.fileCache.delete(normalizedPath);

      this.logger.debug(`Successfully wrote file: ${normalizedPath}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to write file ${path}`, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * Create directory if it doesn't exist
   * Uses adapter.mkdir() for hidden directories since Obsidian doesn't index them
   */
  async ensureDirectory(path: string): Promise<boolean> {
    try {
      const normalizedPath = this.pathManager.normalizePath(path);

      // For hidden directories, use adapter directly
      if (this.isHiddenPath(normalizedPath)) {
        const exists = await this.vault.adapter.exists(normalizedPath);
        if (!exists) {
          await this.vault.adapter.mkdir(normalizedPath);
          this.logger.debug(`Created hidden directory: ${normalizedPath}`);
        }
        return true;
      }

      const existingFolder = await this.getFolder(normalizedPath);

      if (!existingFolder) {
        try {
          await this.vault.createFolder(normalizedPath);
          this.logger.debug(`Created directory: ${normalizedPath}`);
        } catch (createError) {
          // Ignore "Folder already exists" - can happen during startup before vault is fully indexed
          if (createError instanceof Error && !createError.message.includes('already exists')) {
            throw createError;
          }
        }
      }

      return true;
    } catch (error) {
      this.logger.error(`Failed to create directory ${path}`, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * Delete file
   */
  async deleteFile(path: string): Promise<boolean> {
    try {
      const normalizedPath = this.pathManager.normalizePath(path);
      const file = await this.getFile(normalizedPath);
      
      if (file) {
        await this.vault.delete(file);
        this.fileCache.delete(normalizedPath);
        this.logger.debug(`Deleted file: ${normalizedPath}`);
        return true;
      }
      
      this.logger.warn(`File not found for deletion: ${normalizedPath}`);
      return false;
    } catch (error) {
      this.logger.error(`Failed to delete file ${path}`, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * Delete folder
   */
  async deleteFolder(path: string): Promise<boolean> {
    try {
      const normalizedPath = this.pathManager.normalizePath(path);
      const folder = await this.getFolder(normalizedPath);
      
      if (folder) {
        await this.vault.delete(folder);
        this.logger.debug(`Deleted folder: ${normalizedPath}`);
        return true;
      }
      
      this.logger.warn(`Folder not found for deletion: ${normalizedPath}`);
      return false;
    } catch (error) {
      this.logger.error(`Failed to delete folder ${path}`, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * Get file/folder statistics
   */
  async getStats(path: string): Promise<FileStats | null> {
    try {
      const normalizedPath = this.pathManager.normalizePath(path);
      const stat = await this.vault.adapter.stat(normalizedPath);
      
      if (stat) {
        return {
          size: stat.size || 0,
          mtime: stat.mtime || 0,
          ctime: stat.ctime || 0,
          type: stat.type as 'file' | 'folder'
        };
      }
      
      return null;
    } catch (error) {
      this.logger.debug(`Failed to get stats for ${path}`, error);
      return null;
    }
  }

  /**
   * List directory contents
   */
  async listDirectory(path: string): Promise<{ files: string[]; folders: string[] }> {
    try {
      const normalizedPath = this.pathManager.normalizePath(path);
      const listing = await this.vault.adapter.list(normalizedPath);
      
      return {
        files: listing.files,
        folders: listing.folders
      };
    } catch (error) {
      this.logger.error(`Failed to list directory ${path}`, error instanceof Error ? error : new Error(String(error)));
      return { files: [], folders: [] };
    }
  }

  /**
   * Calculate directory size recursively
   */
  async calculateDirectorySize(path: string): Promise<number> {
    try {
      const normalizedPath = this.pathManager.normalizePath(path);
      let totalSize = 0;
      
      const listing = await this.vault.adapter.list(normalizedPath);
      
      // Calculate size of files
      for (const filePath of listing.files) {
        const stat = await this.getStats(filePath);
        if (stat) {
          totalSize += stat.size;
        }
      }
      
      // Recursively calculate size of subdirectories
      for (const folderPath of listing.folders) {
        totalSize += await this.calculateDirectorySize(folderPath);
      }
      
      return totalSize;
    } catch (error) {
      this.logger.error(`Failed to calculate directory size for ${path}`, error instanceof Error ? error : new Error(String(error)));
      return 0;
    }
  }

  /**
   * Batch read operations
   */
  async batchRead(paths: string[]): Promise<Map<string, string | null>> {
    const results = new Map<string, string | null>();
    
    // Process in parallel for better performance
    const promises = paths.map(async (path) => {
      const content = await this.readFile(path);
      results.set(path, content);
    });
    
    await Promise.all(promises);
    return results;
  }

  /**
   * Batch write operations
   */
  async batchWrite(operations: BatchWriteOperation[]): Promise<BatchWriteResult> {
    const success: string[] = [];
    const failed: string[] = [];
    
    // Process in sequence to avoid race conditions
    for (const operation of operations) {
      const result = await this.writeFile(operation.path, operation.content);
      if (result) {
        success.push(operation.path);
      } else {
        failed.push(operation.path);
      }
    }
    
    return { success, failed };
  }

  /**
   * Copy file
   */
  async copyFile(sourcePath: string, targetPath: string): Promise<boolean> {
    try {
      const content = await this.readFile(sourcePath, false);
      if (content === null) {
        this.logger.error(`Source file not found: ${sourcePath}`);
        return false;
      }
      
      return await this.writeFile(targetPath, content);
    } catch (error) {
      this.logger.error(`Failed to copy file from ${sourcePath} to ${targetPath}`, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * Move/rename file
   */
  async moveFile(sourcePath: string, targetPath: string): Promise<boolean> {
    try {
      const normalizedSource = this.pathManager.normalizePath(sourcePath);
      const normalizedTarget = this.pathManager.normalizePath(targetPath);
      
      const sourceFile = await this.getFile(normalizedSource);
      if (!sourceFile) {
        this.logger.error(`Source file not found: ${sourcePath}`);
        return false;
      }
      
      await this.vault.rename(sourceFile, normalizedTarget);
      this.fileCache.delete(normalizedSource);
      
      this.logger.debug(`Moved file from ${sourcePath} to ${targetPath}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to move file from ${sourcePath} to ${targetPath}`, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /**
   * Clear file cache
   */
  clearCache(): void {
    this.fileCache.clear();
    this.logger.debug('File cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; entries: number } {
    const entries = this.fileCache.size;
    let size = 0;
    
    for (const cached of this.fileCache.values()) {
      size += cached.content.length;
    }
    
    return { size, entries };
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.clearCache();
    this.logger.debug('VaultOperations cleaned up');
  }
}