/**
 * PathManager - Centralized path management utility for Obsidian plugin
 * Location: src/utils/PathManager.ts
 * 
 * This class provides centralized path construction, validation, and conversion
 * to eliminate path duplication issues in the Electron environment.
 * 
 * Usage:
 * - By DirectoryService for consistent path operations
 * - By storage services for data path construction
 * - By any service that needs reliable path handling
 */

import { App, Plugin, normalizePath, FileSystemAdapter } from 'obsidian';

export interface PathValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  normalizedPath: string;
}

export interface ConversionResult {
  success: boolean;
  relativePath?: string;
  error?: string;
  strategy?: string;
}

/**
 * Core PathManager class - handles all path operations for the plugin
 */
export class PathManager {
  private readonly vaultBasePath: string | null;
  private readonly pluginId: string;

  constructor(
    private readonly app: App,
    private readonly plugin: Plugin
  ) {
    this.pluginId = plugin.manifest.id;
    this.vaultBasePath = this.detectVaultBasePath();
  }

  /**
   * Detect the vault base path from Obsidian's FileSystemAdapter
   */
  private detectVaultBasePath(): string | null {
    try {
      const adapter = this.app.vault.adapter;
      if (adapter instanceof FileSystemAdapter) {
        return adapter.getBasePath();
      }
      return null; // Mobile or non-FileSystemAdapter
    } catch {
      return null;
    }
  }

  /**
   * Create plugin-relative path - always returns path relative to vault root
   */
  createPluginPath(subPath?: string): string {
    const basePath = `.obsidian/plugins/${this.pluginId}`;
    if (!subPath) return basePath;
    
    const sanitizedSubPath = this.sanitizePath(subPath);
    return `${basePath}/${sanitizedSubPath}`;
  }

  /**
   * Create data directory path - always returns relative path
   */
  createDataPath(subPath?: string): string {
    const dataPath = this.createPluginPath('data');
    if (!subPath) return dataPath;
    
    const sanitizedSubPath = this.sanitizePath(subPath);
    return `${dataPath}/${sanitizedSubPath}`;
  }

  /**
   * Create data storage path - always returns relative path
   */
  createDataStoragePath(subPath: string): string {
    const sanitizedPath = this.sanitizePath(subPath);
    return this.createDataPath(`storage/${sanitizedPath}`);
  }

  /**
   * Convert absolute path to vault-relative path
   * This is the core method that prevents path duplication
   */
  makeVaultRelative(absolutePath: string): string {
    if (!this.vaultBasePath) {
      return this.extractPluginPathFallback(absolutePath);
    }

    try {
      // Strategy 1: Direct base path removal
      const directResult = this.attemptDirectConversion(absolutePath, this.vaultBasePath);
      if (directResult.success && directResult.relativePath) {
        return directResult.relativePath;
      }

      // Strategy 2: Plugin path extraction using regex
      const regexResult = this.attemptRegexConversion(absolutePath);
      if (regexResult.success && regexResult.relativePath) {
        return regexResult.relativePath;
      }

      // Strategy 3: Fallback to safe plugin path
      return this.createDataPath('storage');

    } catch (error) {
      console.error('[PathManager] Path conversion error:', error);
      return this.createDataPath('storage');
    }
  }

  /**
   * Direct conversion strategy - remove vault base path
   */
  private attemptDirectConversion(absolutePath: string, basePath: string): ConversionResult {
    const normalizedAbsolute = this.normalizeSeparators(absolutePath);
    const normalizedBase = this.normalizeSeparators(basePath);

    if (normalizedAbsolute.startsWith(normalizedBase)) {
      let relativePath = normalizedAbsolute.substring(normalizedBase.length);
      
      // Remove leading separator
      if (relativePath.startsWith('/')) {
        relativePath = relativePath.substring(1);
      }
      
      if (relativePath) {
        return {
          success: true,
          relativePath,
          strategy: 'direct'
        };
      }
    }
    
    return {
      success: false,
      error: 'Path does not start with base path'
    };
  }

  /**
   * Regex conversion strategy - extract plugin path pattern
   */
  private attemptRegexConversion(absolutePath: string): ConversionResult {
    const normalized = this.normalizeSeparators(absolutePath);
    
    // Pattern to match: any-prefix/(.obsidian/plugins/plugin-id/...)
    const pattern = /.*[\/\\](\.obsidian[\/\\]plugins[\/\\][^\/\\]+[\/\\].*)$/;
    const match = normalized.match(pattern);
    
    if (match) {
      const relativePath = match[1].replace(/\\/g, '/');
      return {
        success: true,
        relativePath,
        strategy: 'regex'
      };
    }
    
    return {
      success: false,
      error: 'Plugin path pattern not found'
    };
  }

  /**
   * Fallback extraction when other methods fail
   */
  private extractPluginPathFallback(path: string): string {
    const normalized = this.normalizeSeparators(path);
    
    // Look for .obsidian/plugins anywhere in path
    const obsidianIndex = normalized.indexOf('.obsidian/plugins/');
    if (obsidianIndex >= 0) {
      return normalized.substring(obsidianIndex);
    }

    // Ultimate fallback - return safe default
    return this.createDataPath('storage');
  }

  /**
   * Validate path format and detect potential issues
   */
  validatePath(path: string): PathValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check for absolute path indicators
    if (this.isAbsolutePath(path)) {
      errors.push('Path should be relative to vault root, not absolute');
    }

    // Check for backslashes (should use forward slashes)
    if (path.includes('\\')) {
      warnings.push('Path contains backslashes, should use forward slashes');
    }

    // Check for path traversal
    if (path.includes('..')) {
      errors.push('Path traversal sequences (..) are not allowed');
    }

    // Check for duplicated base paths
    if (this.vaultBasePath && this.detectDuplicatedPath(path)) {
      errors.push('Duplicated base path detected');
    }

    // Check path length limits
    if (path.length > 260) {
      warnings.push('Path length exceeds recommended limits for cross-platform compatibility');
    }

    const normalizedPath = this.normalizeSeparators(path);

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      normalizedPath
    };
  }

  /**
   * Detect if path contains duplicated base path
   */
  private detectDuplicatedPath(path: string): boolean {
    if (!this.vaultBasePath) return false;

    const normalizedPath = this.normalizeSeparators(path);
    const normalizedBase = this.normalizeSeparators(this.vaultBasePath);
    
    // Count occurrences of base path
    const basePathPattern = this.escapeRegExp(normalizedBase);
    const matches = normalizedPath.match(new RegExp(basePathPattern, 'g'));
    
    return (matches?.length ?? 0) > 1;
  }

  /**
   * Check if path is absolute
   */
  private isAbsolutePath(path: string): boolean {
    return /^[A-Za-z]:|^\//.test(path);
  }

  /**
   * Normalize path separators to forward slashes
   */
  private normalizeSeparators(path: string): string {
    return path.replace(/\\/g, '/');
  }

  /**
   * Sanitize path component for filesystem safety
   */
  private sanitizePath(path: string): string {
    return path
      .replace(/[<>:"|?*]/g, '_')  // Replace invalid filesystem chars
      .replace(/\\/g, '/')         // Normalize separators
      .replace(/\/+/g, '/')        // Remove duplicate separators
      .replace(/^\/|\/$/g, '')     // Remove leading/trailing separators
      .substring(0, 255);          // Limit length for filesystem compatibility
  }

  /**
   * Escape string for use in regular expression
   */
  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Safe path operation wrapper - validates path before operation
   */
  async safePathOperation<T>(
    path: string,
    operation: (validPath: string) => Promise<T>,
    operationName: string = 'unknown'
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

      // Normalize and execute operation
      const normalizedPath = normalizePath(relativePath);
      return await operation(normalizedPath);

    } catch (error) {
      console.error(`[PathManager] Safe operation '${operationName}' failed for path: ${path}`, error);
      throw error;
    }
  }

  /**
   * Get vault base path if available
   */
  getVaultBasePath(): string | null {
    return this.vaultBasePath;
  }

  /**
   * Check if vault base path is available
   */
  isVaultPathAvailable(): boolean {
    return this.vaultBasePath !== null;
  }
}