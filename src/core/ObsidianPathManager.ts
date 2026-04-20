/**
 * ObsidianPathManager - Path management using Obsidian's normalizePath and proper validation
 * Location: src/core/ObsidianPathManager.ts
 * 
 * This class replaces all manual path construction with Obsidian API-first patterns,
 * ensuring cross-platform compatibility and security through proper validation.
 * 
 * Key improvements over PathManager:
 * - Uses Obsidian's normalizePath function exclusively
 * - Security validation prevents path traversal
 * - Cross-platform path handling (mobile + desktop)
 * - Integration with Vault API for directory operations
 * 
 * Used by:
 * - VaultOperations for all path operations
 * - Plugin data directory management
 * - Configuration file path handling
 */

import { Vault, normalizePath, FileSystemAdapter, type PluginManifest } from 'obsidian';

export interface PathValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  normalizedPath: string;
}

/**
 * Path management using Obsidian's normalizePath and proper validation
 * Replaces all manual path construction
 */
export class ObsidianPathManager {
  private manifest?: PluginManifest;

  constructor(private vault: Vault, manifest?: PluginManifest) {
    this.manifest = manifest;
  }

  /**
   * Core path operations using Obsidian API
   */
  normalizePath(path: string): string {
    // Use Obsidian's official normalizePath function
    return normalizePath(path);
  }

  /**
   * Validate path for security and compatibility
   */
  validatePath(path: string): PathValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Security validation - prevent path traversal
    if (path.includes('..') || path.includes('~')) {
      errors.push('Path traversal sequences are not allowed for security');
    }

    // Platform compatibility checks
    const invalidChars = /[<>:"|?*]/;
    if (invalidChars.test(path)) {
      errors.push('Path contains invalid characters for cross-platform compatibility');
    }

    // Ensure vault-relative (not absolute)
    if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
      errors.push('Path should be relative to vault root, not absolute');
    }

    // Check for dangerous patterns
    if (path.includes('\\')) {
      warnings.push('Path contains backslashes, will be normalized to forward slashes');
    }

    // Path length limits for cross-platform compatibility
    if (path.length > 260) {
      warnings.push('Path length exceeds recommended limits for cross-platform compatibility');
    }

    const normalizedPath = this.normalizePath(path);

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      normalizedPath
    };
  }

  /**
   * Sanitize path component for filesystem safety
   */
  sanitizePath(path: string): string {
    return path
      .replace(/[<>:"|?*]/g, '_')  // Replace invalid filesystem chars
      .replace(/\\/g, '/')         // Normalize separators
      .replace(/\/+/g, '/')        // Remove duplicate separators
      .replace(/^\/|\/$/g, '')     // Remove leading/trailing separators
      .replace(/\.{2,}/g, '_')     // Replace path traversal sequences
      .substring(0, 255);          // Limit length for filesystem compatibility
  }

  /**
   * Plugin-specific path construction
   */
  getPluginDataPath(): string {
    const pluginFolderName = this.getPluginFolderName();
    if (!pluginFolderName) {
      throw new Error('Plugin manifest ID not available for path construction');
    }
    return this.normalizePath(`${this.vault.configDir}/plugins/${pluginFolderName}/data`);
  }

  /**
   * Get storage path for data files
   */
  getStoragePath(fileName: string): string {
    const safeName = this.sanitizePath(fileName);
    return this.normalizePath(`${this.getPluginDataPath()}/storage/${safeName}`);
  }

  /**
   * Get cache directory path
   */
  getCachePath(): string {
    return this.normalizePath(`${this.getPluginDataPath()}/cache`);
  }

  /**
   * Get logs directory path
   */
  getLogsPath(): string {
    return this.normalizePath(`${this.getPluginDataPath()}/logs`);
  }

  /**
   * Get backup directory path
   */
  getBackupPath(): string {
    return this.normalizePath(`${this.getPluginDataPath()}/backups`);
  }

  /**
   * Get JSON storage path
   */
  getDataStoragePath(): string {
    return this.normalizePath(`${this.getPluginDataPath()}/storage`);
  }

  /**
   * Safe path operations with validation
   */
  async ensureParentExists(filePath: string): Promise<void> {
    const parentPath = this.getParentPath(filePath);
    if (parentPath && !this.vault.getFolderByPath(parentPath)) {
      try {
        await this.vault.createFolder(parentPath);
      } catch (error) {
        // Ignore "Folder already exists" - can happen during startup before vault is fully indexed
        if (error instanceof Error && !error.message.includes('already exists')) {
          throw error;
        }
      }
    }
  }

  /**
   * Generate unique path to avoid conflicts
   */
  generateUniquePath(basePath: string): string {
    let uniquePath = basePath;
    let counter = 1;

    while (this.vault.getAbstractFileByPath(uniquePath)) {
      const extension = this.getExtension(basePath);
      const basename = this.getBasename(basePath);
      const parentPath = this.getParentPath(basePath);
      
      const newFileName = extension 
        ? `${basename} ${counter}.${extension}`
        : `${basename} ${counter}`;
      
      uniquePath = parentPath 
        ? this.joinPath(parentPath, newFileName)
        : newFileName;
      
      counter++;
    }

    return uniquePath;
  }

  /**
   * Join path segments safely
   */
  joinPath(...segments: string[]): string {
    return this.normalizePath(
      segments
        .filter(segment => segment && segment.length > 0)
        .join('/')
    );
  }

  /**
   * Get parent directory path
   */
  getParentPath(path: string): string {
    const normalized = this.normalizePath(path);
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash > 0 ? normalized.substring(0, lastSlash) : '';
  }

  /**
   * Get filename without directory
   */
  getFileName(path: string): string {
    const normalized = this.normalizePath(path);
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash >= 0 ? normalized.substring(lastSlash + 1) : normalized;
  }

  /**
   * Get basename (filename without extension)
   */
  getBasename(path: string): string {
    const fileName = this.getFileName(path);
    const lastDot = fileName.lastIndexOf('.');
    return lastDot > 0 ? fileName.substring(0, lastDot) : fileName;
  }

  /**
   * Get file extension
   */
  getExtension(path: string): string {
    const fileName = this.getFileName(path);
    const lastDot = fileName.lastIndexOf('.');
    return lastDot > 0 ? fileName.substring(lastDot + 1) : '';
  }

  /**
   * Check if path is absolute
   */
  isAbsolutePath(path: string): boolean {
    return /^[A-Za-z]:|^\//.test(path);
  }

  /**
   * Convert absolute path to vault-relative (cross-platform safe)
   */
  makeVaultRelative(absolutePath: string): string {
    // Try to get vault base path safely
    const vaultBasePath = this.getVaultBasePath();
    
    if (!vaultBasePath) {
      // Mobile or base path not available - extract plugin path pattern
      return this.extractPluginPathPattern(absolutePath);
    }

    try {
      const normalizedAbsolute = this.normalizePath(absolutePath);
      const normalizedBase = this.normalizePath(vaultBasePath);

      if (normalizedAbsolute.startsWith(normalizedBase)) {
        let relativePath = normalizedAbsolute.substring(normalizedBase.length);
        
        // Remove leading separator
        if (relativePath.startsWith('/')) {
          relativePath = relativePath.substring(1);
        }
        
        return relativePath || this.getPluginDataPath();
      }
      
      // Fallback to pattern extraction
      return this.extractPluginPathPattern(absolutePath);
    } catch {
      // Ultimate fallback
      return this.getPluginDataPath();
    }
  }

  /**
   * Extract plugin path pattern from absolute path
   */
  private extractPluginPathPattern(path: string): string {
    const normalized = this.normalizePath(path);
    const configDir = this.normalizePath(this.vault.configDir);
    const pluginFolderName = this.getPluginFolderName();
    
    // Look for plugin directory pattern
    if (pluginFolderName) {
      const pluginPattern = `/${configDir}/plugins/${pluginFolderName}/`;
      const pluginIndex = normalized.indexOf(pluginPattern);
      
      if (pluginIndex >= 0) {
        // Extract from plugin directory onwards
        const remaining = normalized.substring(pluginIndex + pluginPattern.length);
        return this.normalizePath(`${configDir}/plugins/${pluginFolderName}/${remaining}`);
      }
    }
    
    // Look for configured vault config directory pattern
    const configIndex = normalized.indexOf(`${configDir}/plugins/`);
    if (configIndex >= 0) {
      return normalized.substring(configIndex);
    }

    // Ultimate fallback
    return this.getPluginDataPath();
  }

  /**
   * Get vault base path safely (returns null on mobile)
   */
  private getVaultBasePath(): string | null {
    try {
      const adapter = this.vault.adapter;
      if (adapter instanceof FileSystemAdapter) {
        return adapter.getBasePath();
      }
      return null;
    } catch {
      return null;
    }
  }

  private getPluginFolderName(): string | null {
    if (!this.manifest) {
      return null;
    }

    const manifestDir = this.manifest.dir;
    if (typeof manifestDir === 'string' && manifestDir.trim().length > 0) {
      const normalizedDir = manifestDir.replace(/\\/g, '/');
      const segments = normalizedDir.split('/').filter(Boolean);
      const folderName = segments[segments.length - 1];
      if (folderName) {
        return folderName;
      }
    }

    return this.manifest.id ?? null;
  }

  /**
   * Safe path operation wrapper with validation
   */
  async safePathOperation<T>(
    path: string,
    operation: (validPath: string) => Promise<T>,
    operationName = 'unknown'
  ): Promise<T> {
    try {
      // Convert to relative if absolute
      const relativePath = this.isAbsolutePath(path) 
        ? this.makeVaultRelative(path) 
        : path;

      // Validate the path
      const validation = this.validatePath(relativePath);
      if (!validation.isValid) {
        throw new Error(`Path validation failed: ${validation.errors.join(', ')}`);
      }

      return await operation(validation.normalizedPath);

    } catch (error) {
      console.error(`[ObsidianPathManager] Safe operation '${operationName}' failed for path: ${path}`, error);
      throw error;
    }
  }

  /**
   * Batch validate paths
   */
  validatePaths(paths: string[]): Map<string, PathValidationResult> {
    const results = new Map<string, PathValidationResult>();
    
    for (const path of paths) {
      results.set(path, this.validatePath(path));
    }
    
    return results;
  }

  /**
   * Get path type (file or folder)
   */
  async getPathType(path: string): Promise<'file' | 'folder' | null> {
    try {
      const normalizedPath = this.normalizePath(path);
      const stat = await this.vault.adapter.stat(normalizedPath);
      return stat?.type as 'file' | 'folder' || null;
    } catch {
      return null;
    }
  }

  /**
   * Check if path exists
   */
  async pathExists(path: string): Promise<boolean> {
    try {
      const normalizedPath = this.normalizePath(path);
      return await this.vault.adapter.exists(normalizedPath);
    } catch {
      return false;
    }
  }
}
