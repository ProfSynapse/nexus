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
  async saveData<T = unknown>(data: T): Promise<void> {
    await this.plugin.saveData(data);
  }

  /**
   * Load data from plugin storage
   */
  async loadData<T = unknown>(): Promise<T | null> {
    return await this.plugin.loadData() as T | null;
  }

  /**
   * Load data with defaults and migration support
   */
  async load<T = unknown>(defaults?: T, migrateFn?: (data: T) => T): Promise<T | undefined> {
    try {
      let data = await this.plugin.loadData() as T | undefined;
      if (data === undefined || data === null) {
        return defaults;
      }
      if (migrateFn) {
        data = migrateFn(data);
      }
      return data;
    } catch {
      return defaults;
    }
  }

  /**
   * Check if data exists
   */
  async hasData(): Promise<boolean> {
    try {
      const data = (await this.plugin.loadData()) as unknown;
      return data !== null && data !== undefined;
    } catch {
      return false;
    }
  }
}

// Legacy compatibility exports
export class SettingsMigrationManager {
  static migrate<T = unknown>(data: T): T {
    return data;
  }
}

export interface SettingsSchema {
  [key: string]: unknown;
}

export interface SettingsMigration<T = unknown> {
  version: number;
  migrate: (data: T) => T;
}

export interface BackupData<T = unknown> {
  version: string;
  timestamp: number;
  data: T;
}
