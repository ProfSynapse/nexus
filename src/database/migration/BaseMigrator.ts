/**
 * Location: src/database/migration/BaseMigrator.ts
 *
 * Abstract base class for file migrators.
 * Provides DRY implementation of file iteration, status tracking, and error handling.
 *
 * Subclasses implement:
 * - category: 'workspaces' or 'conversations'
 * - listFiles(): Get files to migrate
 * - migrateFile(): Migrate a single file
 * - createEmptyResult(): Create initial result object
 */

import { App } from 'obsidian';
import { JSONLWriter } from '../storage/JSONLWriter';
import { LegacyFileScanner } from './LegacyFileScanner';
import { MigrationStatusTracker } from './MigrationStatusTracker';
import { MigrationCategory } from './types';

/**
 * Base interface for migration results - all results must have errors array
 */
export interface BaseMigrationResult {
  errors: string[];
}

/**
 * Abstract base class for migrators
 */
export abstract class BaseMigrator<TResult extends BaseMigrationResult> {
  protected app: App;
  protected jsonlWriter: JSONLWriter;
  protected fileScanner: LegacyFileScanner;
  protected statusTracker: MigrationStatusTracker;

  /** Category of files this migrator handles */
  protected abstract readonly category: MigrationCategory;

  constructor(
    app: App,
    jsonlWriter: JSONLWriter,
    fileScanner: LegacyFileScanner,
    statusTracker: MigrationStatusTracker
  ) {
    this.app = app;
    this.jsonlWriter = jsonlWriter;
    this.fileScanner = fileScanner;
    this.statusTracker = statusTracker;
  }

  /**
   * Migrate all files in this category.
   * Handles file iteration, status tracking, and error collection.
   */
  async migrate(): Promise<TResult> {
    const result = this.createEmptyResult();

    try {
      const files = await this.listFiles();

      for (const filePath of files) {
        // Skip if already migrated (duplicate prevention)
        if (await this.statusTracker.isFileMigrated(this.category, filePath)) {
          continue;
        }

        try {
          await this.migrateFile(filePath, result);
          await this.statusTracker.markFileMigrated(this.category, filePath);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`Failed to migrate ${filePath}: ${message}`);
          console.error(`[${this.constructor.name}] Error migrating ${filePath}:`, error);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`Failed to list ${this.category} files: ${message}`);
      console.error(`[${this.constructor.name}] Error listing files:`, error);
    }

    return result;
  }

  /**
   * Get list of files to migrate
   */
  protected abstract listFiles(): Promise<string[]>;

  /**
   * Migrate a single file. Updates result with migration counts.
   */
  protected abstract migrateFile(filePath: string, result: TResult): Promise<void>;

  /**
   * Create an empty result object
   */
  protected abstract createEmptyResult(): TResult;
}
