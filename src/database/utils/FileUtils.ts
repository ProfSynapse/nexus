/**
 * FileUtils - Utility functions for file operations and validation
 * 
 * This utility module provides common file validation and checking patterns
 * used across the hash comparison and search services. Consolidates
 * repeated file existence checking logic into reusable methods.
 */

import { App, TAbstractFile, TFile } from 'obsidian';

export class FileUtils {
  /**
   * Check if an abstract file is a valid readable file (not a folder)
   * @param file Abstract file to check
   * @returns True if file is valid and readable
   */
  static isValidFile(file: TAbstractFile | null): file is TFile {
    return file !== null && !('children' in file);
  }

  /**
   * Check if a file path points to a valid readable file
   * @param app Obsidian app instance
   * @param filePath Path to check
   * @returns True if path points to a valid file
   */
  static isValidFilePath(app: App, filePath: string): boolean {
    const file = app.vault.getAbstractFileByPath(filePath);
    return this.isValidFile(file);
  }

  /**
   * Normalize file path to use forward slashes consistently
   * @param filePath Path to normalize
   * @returns Normalized path with forward slashes
   */
  static normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
  }
}