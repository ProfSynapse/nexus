/**
 * Location: src/database/migration/MigrationStatusTracker.ts
 *
 * Tracks migration status and progress.
 * Stores status in .nexus/migration-status.json
 */

import { App } from 'obsidian';
import { MigrationStatus, MigrationCategory } from './types';

export class MigrationStatusTracker {
  private app: App;
  private statusPath = '.nexus/migration-status.json';

  constructor(app: App) {
    this.app = app;
  }

  /**
   * Load migration status from file
   */
  async load(): Promise<MigrationStatus | null> {
    try {
      // Use adapter directly for consistency with save()
      const exists = await this.app.vault.adapter.exists(this.statusPath);
      if (!exists) {
        return null;
      }

      const content = await this.app.vault.adapter.read(this.statusPath);
      const status = JSON.parse(content);
      return status;
    } catch (error) {
      console.error('[MigrationStatusTracker] Failed to load status:', error);
      return null;
    }
  }

  /**
   * Save migration status to file
   */
  async save(status: MigrationStatus): Promise<void> {
    try {
      const content = JSON.stringify(status, null, 2);

      // Ensure .nexus directory exists
      const dirPath = '.nexus';
      const dirExists = await this.app.vault.adapter.exists(dirPath);
      if (!dirExists) {
        await this.app.vault.adapter.mkdir(dirPath);
      }

      // Write status file (create or update)
      await this.app.vault.adapter.write(this.statusPath, content);
    } catch (error) {
      console.error('[MigrationStatusTracker] Failed to save migration status:', error);
      throw error;
    }
  }

  /**
   * Check if migration is complete for given version
   */
  async isCompleteForVersion(version: string): Promise<boolean> {
    const status = await this.load();
    return status?.completed === true && status.version === version;
  }

  /**
   * Check if a specific file has been migrated
   */
  async isFileMigrated(category: MigrationCategory, filePath: string): Promise<boolean> {
    const status = await this.load();
    if (!status?.migratedFiles) {
      return false;
    }
    return status.migratedFiles[category]?.includes(filePath) ?? false;
  }

  /**
   * Mark a file as migrated
   */
  async markFileMigrated(category: MigrationCategory, filePath: string): Promise<void> {
    let status = await this.load();

    // Initialize status if needed
    if (!status) {
      status = {
        completed: false,
        version: '',
        migratedFiles: { workspaces: [], conversations: [] },
      };
    }

    // Initialize migratedFiles if needed
    if (!status.migratedFiles) {
      status.migratedFiles = { workspaces: [], conversations: [] };
    }

    // Add file if not already present
    if (!status.migratedFiles[category].includes(filePath)) {
      status.migratedFiles[category].push(filePath);
      await this.save(status);
    }
  }

  /**
   * Get all migrated files
   */
  async getMigratedFiles(): Promise<{ workspaces: string[]; conversations: string[] }> {
    const status = await this.load();
    return status?.migratedFiles ?? { workspaces: [], conversations: [] };
  }

  /**
   * Check if legacy folders have been archived
   */
  async isLegacyArchived(): Promise<boolean> {
    const status = await this.load();
    return status?.legacyArchived === true;
  }

  /**
   * Mark legacy folders as archived
   */
  async markLegacyArchived(): Promise<void> {
    let status = await this.load();

    if (!status) {
      status = {
        completed: false,
        version: '',
        legacyArchived: true,
      };
    } else {
      status.legacyArchived = true;
    }

    await this.save(status);
  }
}
