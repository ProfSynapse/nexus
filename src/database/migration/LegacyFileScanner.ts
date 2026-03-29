/**
 * Location: src/database/migration/LegacyFileScanner.ts
 *
 * Scans for legacy JSON files in .workspaces and .conversations folders.
 * Uses vault.adapter for hidden folder support.
 */

import { App } from 'obsidian';

export class LegacyFileScanner {
  private app: App;
  private legacyWorkspacesPath = '.workspaces';
  private legacyConversationsPath = '.conversations';

  constructor(app: App) {
    this.app = app;
  }

  /**
   * Check if legacy workspaces folder exists and has data
   */
  async hasLegacyWorkspaces(): Promise<boolean> {
    try {
      const exists = await this.app.vault.adapter.exists(this.legacyWorkspacesPath);
      if (!exists) return false;

      const listing = await this.app.vault.adapter.list(this.legacyWorkspacesPath);
      const jsonFiles = listing.files.filter(f => f.endsWith('.json') && !f.endsWith('index.json'));
      return jsonFiles.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Check if legacy conversations folder exists and has data
   */
  async hasLegacyConversations(): Promise<boolean> {
    try {
      const exists = await this.app.vault.adapter.exists(this.legacyConversationsPath);
      if (!exists) return false;

      const listing = await this.app.vault.adapter.list(this.legacyConversationsPath);
      const jsonFiles = listing.files.filter(f => f.endsWith('.json') && !f.endsWith('index.json'));
      return jsonFiles.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * List all workspace JSON file paths in legacy folder
   */
  async listLegacyWorkspaceFilePaths(): Promise<string[]> {
    try {
      const exists = await this.app.vault.adapter.exists(this.legacyWorkspacesPath);
      if (!exists) {
        return [];
      }

      const listing = await this.app.vault.adapter.list(this.legacyWorkspacesPath);
      return listing.files.filter(f => {
        // Must be .json file
        if (!f.endsWith('.json')) return false;
        // Skip index and schema files
        const filename = f.split('/').pop() || '';
        if (filename === 'index.json') return false;
        if (filename.startsWith('.')) return false;
        if (filename.includes('schema')) return false;
        return true;
      });
    } catch (error) {
      console.error('[LegacyFileScanner] Error listing workspace files:', error);
      return [];
    }
  }

  /**
   * List all conversation JSON file paths in legacy folder
   */
  async listLegacyConversationFilePaths(): Promise<string[]> {
    try {
      const exists = await this.app.vault.adapter.exists(this.legacyConversationsPath);
      if (!exists) {
        return [];
      }

      const listing = await this.app.vault.adapter.list(this.legacyConversationsPath);
      return listing.files.filter(f => f.endsWith('.json') && !f.endsWith('index.json'));
    } catch (error) {
      console.error('[LegacyFileScanner] Error listing conversation files:', error);
      return [];
    }
  }

  /**
   * Read file content via adapter (works for hidden files)
   */
  async readFile(path: string): Promise<string | null> {
    try {
      return await this.app.vault.adapter.read(path);
    } catch (error) {
      console.error(`[LegacyFileScanner] Error reading file ${path}:`, error);
      return null;
    }
  }
}
