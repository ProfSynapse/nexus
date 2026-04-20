/**
 * Location: src/database/migration/LegacyArchiver.ts
 *
 * Archives legacy JSON folders after successful migration.
 * Renames .workspaces → .workspaces-archived
 * Renames .conversations → .conversations-archived
 */

import { App } from 'obsidian';

export interface ArchiveResult {
  archived: string[];
  errors: string[];
}

export class LegacyArchiver {
  private app: App;
  private legacyWorkspacesPath = '.workspaces';
  private legacyConversationsPath = '.conversations';
  private archivedWorkspacesPath = '.workspaces-archived';
  private archivedConversationsPath = '.conversations-archived';

  constructor(app: App) {
    this.app = app;
  }

  /**
   * Archive legacy folders by renaming them with -archived suffix
   */
  async archiveLegacyFolders(): Promise<ArchiveResult> {
    const result: ArchiveResult = {
      archived: [],
      errors: [],
    };

    // Archive workspaces folder
    await this.archiveFolder(
      this.legacyWorkspacesPath,
      this.archivedWorkspacesPath,
      result
    );

    // Archive conversations folder
    await this.archiveFolder(
      this.legacyConversationsPath,
      this.archivedConversationsPath,
      result
    );

    return result;
  }

  /**
   * Archive a single folder
   */
  private async archiveFolder(
    sourcePath: string,
    destPath: string,
    result: ArchiveResult
  ): Promise<void> {
    try {
      // Check if source folder exists
      const sourceExists = await this.app.vault.adapter.exists(sourcePath);
      if (!sourceExists) {
        return; // Nothing to archive
      }

      // Check if destination already exists
      const destExists = await this.app.vault.adapter.exists(destPath);
      if (destExists) {
        return; // Already archived
      }

      // Rename folder
      await this.app.vault.adapter.rename(sourcePath, destPath);
      result.archived.push(sourcePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`Failed to archive ${sourcePath}: ${message}`);
      console.error(`[LegacyArchiver] Error archiving ${sourcePath}:`, error);
    }
  }

  /**
   * Check if legacy folders have been archived
   */
  async isArchived(): Promise<boolean> {
    // Check if original folders don't exist and archived folders do
    const workspacesExists = await this.app.vault.adapter.exists(this.legacyWorkspacesPath);
    const conversationsExists = await this.app.vault.adapter.exists(this.legacyConversationsPath);

    // If either original folder exists, not fully archived
    if (workspacesExists || conversationsExists) {
      return false;
    }

    // Check if at least one archived folder exists (indicates archive was done)
    const archivedWorkspacesExists = await this.app.vault.adapter.exists(this.archivedWorkspacesPath);
    const archivedConversationsExists = await this.app.vault.adapter.exists(this.archivedConversationsPath);

    return archivedWorkspacesExists || archivedConversationsExists;
  }

  /**
   * Check if legacy folders exist (migration source)
   */
  async hasLegacyFolders(): Promise<boolean> {
    const workspacesExists = await this.app.vault.adapter.exists(this.legacyWorkspacesPath);
    const conversationsExists = await this.app.vault.adapter.exists(this.legacyConversationsPath);
    return workspacesExists || conversationsExists;
  }

  /**
   * Check if archive folders exist (indicates previous migration completed archiving)
   */
  async archiveFoldersExist(): Promise<boolean> {
    const archivedWorkspacesExists = await this.app.vault.adapter.exists(this.archivedWorkspacesPath);
    const archivedConversationsExists = await this.app.vault.adapter.exists(this.archivedConversationsPath);
    return archivedWorkspacesExists || archivedConversationsExists;
  }
}
