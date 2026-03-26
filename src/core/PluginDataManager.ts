/**
 * Plugin Data Manager
 * Handles simple plugin data storage operations using Obsidian's native data.json
 */

import { Plugin } from 'obsidian';

export class PluginDataManager {
  constructor(private plugin: Plugin) {}

  /**
   * Save data to plugin storage
   */
  async saveData(data: unknown): Promise<void> {
    await this.plugin.saveData(data);
  }

  /**
   * Load data from plugin storage
   */
  async loadData(): Promise<unknown> {
    return await this.plugin.loadData();
  }

  /**
   * Load data with defaults and migration support
   */
  async load<T>(defaults: T, migrateFn?: (data: unknown) => T): Promise<T> {
    try {
      let data: unknown = await this.plugin.loadData();
      if (!data) {
        data = defaults;
      }
      if (migrateFn) {
        data = migrateFn(data);
      }
      return data as T;
    } catch {
      return defaults;
    }
  }

  /**
   * Check if data exists
   */
  async hasData(): Promise<boolean> {
    try {
      const data: unknown = await this.plugin.loadData();
      return data !== null && data !== undefined;
    } catch {
      return false;
    }
  }
}

// Legacy compatibility exports
export class SettingsMigrationManager {
  static migrate<T>(data: T): T {
    return data;
  }
}

export interface SettingsSchema {
  [key: string]: unknown;
}

export interface SettingsMigration {
  version: number;
  migrate: (data: unknown) => unknown;
}

export interface BackupData {
  version: string;
  timestamp: number;
  data: unknown;
}