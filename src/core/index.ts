/**
 * Core Components Index - Obsidian API-First Architecture
 * Location: src/core/index.ts
 * 
 * Central export point for all core architecture components that implement
 * the Obsidian API-first migration. This provides clean imports and ensures
 * consistent usage across the codebase.
 * 
 * Components provided:
 * - VaultOperations: Cross-platform file operations using Vault API
 * - ObsidianPathManager: Path management with security and normalization
 * - PluginDataManager: Type-safe settings and data persistence
 * - StructuredLogger: Configurable logging system
 * - ServiceContainer: Dependency injection container
 * 
 * Usage:
 * import { VaultOperations, StructuredLogger } from './core';
 */

// Core services
export { VaultOperations } from './VaultOperations';
export { ObsidianPathManager } from './ObsidianPathManager';
export { PluginDataManager, SettingsMigrationManager } from './PluginDataManager';
export { StructuredLogger, ContextLogger, LogLevel } from './StructuredLogger';
export { ServiceContainer } from './ServiceContainer';

// Type exports for external usage
export type { 
  BatchWriteOperation, 
  BatchWriteResult, 
  FileStats 
} from './VaultOperations';

export type { 
  PathValidationResult 
} from './ObsidianPathManager';

export type { 
  SettingsSchema, 
  SettingsMigration, 
  BackupData 
} from './PluginDataManager';

export type { 
  LogEntry, 
  LoggerConfig 
} from './StructuredLogger';

export type { 
  ServiceFactory, 
  ServiceRegistration, 
  ServiceMetadata 
} from './ServiceContainer';

/**
 * Utility function to create a complete service setup for a plugin
 * This provides a quick way to bootstrap the new architecture
 */
export async function createCoreServices(plugin: any) {
  // Import components directly to avoid circular dependency
  const { StructuredLogger } = await import('./StructuredLogger');
  const { ObsidianPathManager } = await import('./ObsidianPathManager');
  const { PluginDataManager } = await import('./PluginDataManager');
  const { VaultOperations } = await import('./VaultOperations');
  const { ServiceContainer } = await import('./ServiceContainer');
  
  // Create logger first
  const logger = new StructuredLogger(plugin);
  
  // Create path manager with manifest
  const pathManager = new ObsidianPathManager(plugin.app.vault, plugin.manifest);
  
  // Create data manager with defaults
  const dataManager = new PluginDataManager(plugin);
  await dataManager.load();
  
  // Create vault operations
  const vaultOperations = new VaultOperations(plugin.app.vault, pathManager, logger);
  
  // Create service container
  const container = new ServiceContainer();
  
  // Register core services
  container.register('logger', () => logger);
  container.register('pathManager', () => pathManager);
  container.register('dataManager', () => dataManager);
  container.register('vaultOperations', () => vaultOperations);
  
  return {
    logger,
    pathManager,
    dataManager,
    vaultOperations,
    container
  };
}

/**
 * Architecture validation utility
 * Helps ensure proper implementation of the new patterns
 */
export function validateArchitecture(plugin: any): {
  valid: boolean;
  issues: string[];
  recommendations: string[];
} {
  const issues: string[] = [];
  const recommendations: string[] = [];
  
  // Check if using new core components
  if (!plugin.logger || plugin.logger.constructor.name !== 'StructuredLogger') {
    issues.push('Plugin should use StructuredLogger instead of console.log');
    recommendations.push('Replace console.log statements with this.logger.info/debug/warn/error');
  }
  
  if (!plugin.pathManager || plugin.pathManager.constructor.name !== 'ObsidianPathManager') {
    issues.push('Plugin should use ObsidianPathManager for path operations');
    recommendations.push('Replace manual path construction with pathManager methods');
  }
  
  if (!plugin.vaultOperations || plugin.vaultOperations.constructor.name !== 'VaultOperations') {
    issues.push('Plugin should use VaultOperations instead of Node.js fs');
    recommendations.push('Replace require("fs") operations with vaultOperations methods');
  }
  
  if (!plugin.dataManager || plugin.dataManager.constructor.name !== 'PluginDataManager') {
    issues.push('Plugin should use PluginDataManager for settings');
    recommendations.push('Replace manual Plugin.loadData/saveData with dataManager');
  }
  
  // Check for anti-patterns
  const pluginCode = plugin.toString();
  
  if (pluginCode.includes('require("fs")') || pluginCode.includes('require(\'fs\')')) {
    issues.push('Node.js filesystem usage detected');
    recommendations.push('Use VaultOperations for cross-platform file operations');
  }
  
  if (pluginCode.includes('console.log') || pluginCode.includes('console.error')) {
    issues.push('Direct console logging detected');
    recommendations.push('Use StructuredLogger for proper log management');
  }
  
  if (pluginCode.includes('FileSystemAdapter')) {
    issues.push('Direct FileSystemAdapter usage detected');
    recommendations.push('Use ObsidianPathManager for cross-platform path handling');
  }
  
  return {
    valid: issues.length === 0,
    issues,
    recommendations
  };
}

/**
 * Migration helper to gradually transition from old to new architecture
 */
export class ArchitectureMigrationHelper {
  constructor(private plugin: any) {}
  
  /**
   * Phase 1: Replace console logging
   */
  async migrateLogging(): Promise<void> {
    if (!this.plugin.logger) {
      const { StructuredLogger } = await import('./StructuredLogger');
      this.plugin.logger = new StructuredLogger(this.plugin);
    }
  }
  
  /**
   * Phase 2: Replace path management
   */
  async migratePaths(): Promise<void> {
    if (!this.plugin.pathManager) {
      const { ObsidianPathManager } = await import('./ObsidianPathManager');
      this.plugin.pathManager = new ObsidianPathManager(
        this.plugin.app.vault,
        this.plugin.manifest
      );
    }
  }
  
  /**
   * Phase 3: Replace file operations
   */
  async migrateFileOperations(): Promise<void> {
    if (!this.plugin.vaultOperations && this.plugin.pathManager && this.plugin.logger) {
      const { VaultOperations } = await import('./VaultOperations');
      this.plugin.vaultOperations = new VaultOperations(
        this.plugin.app.vault,
        this.plugin.pathManager,
        this.plugin.logger
      );
    }
  }
  
  /**
   * Phase 4: Replace data management
   */
  async migrateDataManagement(defaults: any): Promise<void> {
    if (!this.plugin.dataManager) {
      const { PluginDataManager } = await import('./PluginDataManager');
      this.plugin.dataManager = new PluginDataManager(this.plugin);
      await this.plugin.dataManager.load();
    }
  }
  
  /**
   * Complete migration in phases
   */
  async performFullMigration(defaults: any): Promise<void> {
    await this.migrateLogging();
    await this.migratePaths();
    await this.migrateFileOperations();
    await this.migrateDataManagement(defaults);
  }
}