/**
 * Location: src/database/migration/types.ts
 *
 * Shared types for the migration system.
 */

/**
 * Migration status tracking
 */
export interface MigrationStatus {
  /** Whether migration has been completed */
  completed: boolean;

  /** Timestamp when migration started */
  startedAt?: number;

  /** Timestamp when migration completed */
  completedAt?: number;

  /** Version of migration logic */
  version: string;

  /** Migration statistics */
  stats?: {
    workspacesMigrated: number;
    sessionsMigrated: number;
    statesMigrated: number;
    tracesMigrated: number;
    conversationsMigrated: number;
    messagesMigrated: number;
    errors: string[];
  };

  /** Device that performed the migration */
  deviceId?: string;

  /** Any errors encountered during migration */
  errors?: string[];

  /** Per-file tracking to prevent duplicates on version bumps */
  migratedFiles?: {
    workspaces: string[];
    conversations: string[];
  };

  /** Whether legacy folders have been archived */
  legacyArchived?: boolean;
}

/** Category of migration files */
export type MigrationCategory = 'workspaces' | 'conversations';

/**
 * Migration result returned to caller
 */
export interface MigrationResult {
  /** Whether migration was needed */
  needed: boolean;

  /** Whether migration completed successfully */
  success: boolean;

  /** Migration statistics */
  stats: MigrationStats;

  /** Any errors encountered */
  errors: string[];

  /** Duration of migration in milliseconds */
  duration: number;

  /** Human-readable message */
  message: string;
}

/**
 * Migration statistics
 */
export interface MigrationStats {
  workspacesMigrated: number;
  sessionsMigrated: number;
  statesMigrated: number;
  tracesMigrated: number;
  conversationsMigrated: number;
  messagesMigrated: number;
}

/**
 * Workspace migration result
 */
export interface WorkspaceMigrationResult {
  workspaces: number;
  sessions: number;
  states: number;
  traces: number;
  errors: string[];
}

/**
 * Conversation migration result
 */
export interface ConversationMigrationResult {
  conversations: number;
  messages: number;
  errors: string[];
}
