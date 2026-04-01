/**
 * FileReader — Centralized vault read abstraction for the Composer agent.
 *
 * Located at: src/agents/apps/composer/services/FileReader.ts
 * All path validation and size checks happen here — composers never touch
 * the vault directly for file resolution. Uses isValidPath() for security
 * (NOT sanitizePath, which preserves ".." segments).
 *
 * Used by: compose.ts tool to resolve and validate file paths before
 * passing TFile objects to format-specific composers.
 */

import { TFile, Vault, normalizePath } from 'obsidian';
import { isValidPath } from '../../../../utils/pathUtils';
import { ComposerError } from '../types';

export class FileReader {
  private readonly vault: Vault;
  private readonly maxFileSizeMb: number;

  constructor(vault: Vault, maxFileSizeMb = 50) {
    this.vault = vault;
    this.maxFileSizeMb = maxFileSizeMb;
  }

  /**
   * Validate and resolve an array of vault-relative paths to TFile objects.
   * Applies the defense-in-depth chain: isValidPath -> normalizePath -> getFileByPath -> stat.size.
   *
   * @throws ComposerError with failedFiles[] if any path is invalid or file not found.
   */
  resolveFiles(paths: string[]): TFile[] {
    const resolved: TFile[] = [];
    const failed: string[] = [];

    for (const rawPath of paths) {
      // Step 1: Security validation — rejects absolute paths, traversal, invalid chars
      if (!isValidPath(rawPath)) {
        failed.push(rawPath);
        continue;
      }

      // Step 2: Normalize — strips leading slash, fixes separators
      const normalized = normalizePath(rawPath);

      // Step 3: Confirm file exists in vault
      const file = this.vault.getFileByPath(normalized);
      if (!file) {
        failed.push(rawPath);
        continue;
      }

      // Step 4: Size guard BEFORE any read
      const maxBytes = this.maxFileSizeMb * 1024 * 1024;
      if (file.stat.size > maxBytes) {
        failed.push(rawPath);
        continue;
      }

      resolved.push(file);
    }

    if (failed.length > 0) {
      throw new ComposerError(
        `${failed.length} file(s) could not be resolved: invalid path, not found, or exceeds ${this.maxFileSizeMb}MB limit`,
        failed
      );
    }

    return resolved;
  }

  /**
   * Read a text file's content.
   * Call resolveFiles() first to validate the file.
   */
  async readText(file: TFile): Promise<string> {
    return this.vault.read(file);
  }

  /**
   * Read a binary file's content.
   * Call resolveFiles() first to validate the file.
   */
  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return this.vault.readBinary(file);
  }
}
