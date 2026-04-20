/**
 * Location: src/database/migration/index.ts
 *
 * Migration Module Exports
 *
 * Central export point for the legacy JSON to JSONL/SQLite migration system.
 */

// Main orchestrator
export { LegacyMigrator } from './LegacyMigrator';

// Base class for migrators (DRY)
export { BaseMigrator } from './BaseMigrator';
export type { BaseMigrationResult } from './BaseMigrator';

// Specialized migrators
export { WorkspaceMigrator } from './WorkspaceMigrator';
export { ConversationMigrator } from './ConversationMigrator';

// Support classes
export { LegacyFileScanner } from './LegacyFileScanner';
export { MigrationStatusTracker } from './MigrationStatusTracker';
export { LegacyArchiver } from './LegacyArchiver';
export type { ArchiveResult } from './LegacyArchiver';

// Types
export type {
  MigrationStatus,
  MigrationResult,
  MigrationStats,
  MigrationCategory,
  WorkspaceMigrationResult,
  ConversationMigrationResult,
} from './types';
