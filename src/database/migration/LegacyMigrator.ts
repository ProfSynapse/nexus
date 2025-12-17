/**
 * Location: src/database/migration/LegacyMigrator.ts
 *
 * Legacy JSON to JSONL/SQLite Migration Orchestrator
 *
 * Thin orchestrator that delegates to specialized migrators:
 * - LegacyFileScanner: Scans for legacy JSON files
 * - MigrationStatusTracker: Tracks migration progress and per-file status
 * - WorkspaceMigrator: Migrates workspace/session/state/trace data
 * - ConversationMigrator: Migrates conversation/message data
 * - LegacyArchiver: Archives legacy folders after migration
 *
 * Design Principles:
 * - Single Responsibility: Orchestration only, no direct migration logic
 * - Open/Closed: Add new migrators without modifying this class
 * - Dependency Injection: All dependencies passed to constructor
 *
 * Duplicate Prevention:
 * - Per-file tracking in migration-status.json
 * - Files already in migratedFiles list are always skipped
 * - Safe to run multiple times or after version bumps
 */

import { App } from 'obsidian';
import { JSONLWriter } from '../storage/JSONLWriter';
import { LegacyFileScanner } from './LegacyFileScanner';
import { MigrationStatusTracker } from './MigrationStatusTracker';
import { WorkspaceMigrator } from './WorkspaceMigrator';
import { ConversationMigrator } from './ConversationMigrator';
import { LegacyArchiver } from './LegacyArchiver';
import { MigrationResult, MigrationStats, MigrationStatus } from './types';

// Re-export types for backward compatibility
export type { MigrationStatus, MigrationResult } from './types';

/**
 * Legacy data migrator for JSON to JSONL/SQLite transition
 *
 * Usage:
 * ```typescript
 * const migrator = new LegacyMigrator(app);
 * const result = await migrator.migrate();
 *
 * if (result.needed) {
 *   console.log(`Migration completed: ${result.message}`);
 * }
 * ```
 */
export class LegacyMigrator {
  private app: App;
  private jsonlWriter: JSONLWriter;
  private fileScanner: LegacyFileScanner;
  private statusTracker: MigrationStatusTracker;
  private workspaceMigrator: WorkspaceMigrator;
  private conversationMigrator: ConversationMigrator;
  private archiver: LegacyArchiver;

  // Current migration version - increment to force re-migration
  // 1.0.0 - Initial migration
  // 1.1.0 - Fixed message migration detection
  // 1.2.0 - Fixed JSONLWriter.appendEvent() for hidden folders
  // 1.3.0 - Added per-file tracking and legacy archival
  private readonly MIGRATION_VERSION = '1.3.0';

  constructor(app: App) {
    this.app = app;
    this.jsonlWriter = new JSONLWriter({ app, basePath: '.nexus' });
    this.fileScanner = new LegacyFileScanner(app);
    this.statusTracker = new MigrationStatusTracker(app);
    this.archiver = new LegacyArchiver(app);

    // Pass statusTracker to migrators for per-file tracking
    this.workspaceMigrator = new WorkspaceMigrator(
      app,
      this.jsonlWriter,
      this.fileScanner,
      this.statusTracker
    );
    this.conversationMigrator = new ConversationMigrator(
      app,
      this.jsonlWriter,
      this.fileScanner,
      this.statusTracker
    );
  }

  /**
   * Check if migration is needed
   */
  async isMigrationNeeded(): Promise<boolean> {
    try {
      // Check if legacy folders have been archived (status file flag)
      const isArchivedFlag = await this.statusTracker.isLegacyArchived();
      if (isArchivedFlag) {
        return false;
      }

      // Also check if archive folders exist (in case status file is incomplete)
      const archiveFoldersExist = await this.archiver.archiveFoldersExist();
      if (archiveFoldersExist) {
        // Archive folders exist but flag not set - set it now and skip migration
        await this.statusTracker.markLegacyArchived();
        return false;
      }

      // Check if legacy folders exist
      const hasLegacy = await this.archiver.hasLegacyFolders();
      if (!hasLegacy) {
        return false;
      }

      const hasUnmigratedWorkspaces = await this.hasUnmigratedFiles('workspaces');
      const hasUnmigratedConversations = await this.hasUnmigratedFiles('conversations');

      return hasUnmigratedWorkspaces || hasUnmigratedConversations;
    } catch (error) {
      console.error('[LegacyMigrator] Error checking migration status:', error);
      return false;
    }
  }

  /**
   * Check if there are unmigrated files in a category
   */
  private async hasUnmigratedFiles(category: 'workspaces' | 'conversations'): Promise<boolean> {
    const migratedFiles = await this.statusTracker.getMigratedFiles();
    const migratedSet = new Set(migratedFiles[category]);

    const allFiles = category === 'workspaces'
      ? await this.fileScanner.listLegacyWorkspaceFilePaths()
      : await this.fileScanner.listLegacyConversationFilePaths();

    return allFiles.some(file => !migratedSet.has(file));
  }

  /**
   * Perform the migration from legacy JSON to JSONL/SQLite
   */
  async migrate(): Promise<MigrationResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    const stats: MigrationStats = {
      workspacesMigrated: 0,
      sessionsMigrated: 0,
      statesMigrated: 0,
      tracesMigrated: 0,
      conversationsMigrated: 0,
      messagesMigrated: 0,
    };

    try {
      // Check if migration is needed
      const needed = await this.isMigrationNeeded();
      if (!needed) {
        return this.createResult(false, true, stats, [], startTime,
          'Migration not needed - already completed or no legacy data found');
      }

      // Ensure directory structure exists
      await this.ensureDirectories();

      // Record migration start
      await this.statusTracker.save({
        completed: false,
        startedAt: startTime,
        version: this.MIGRATION_VERSION,
        deviceId: this.jsonlWriter.getDeviceId(),
      });

      // Migrate workspaces
      const workspaceResult = await this.migrateWorkspacesSafely(errors);
      stats.workspacesMigrated = workspaceResult.workspaces;
      stats.sessionsMigrated = workspaceResult.sessions;
      stats.statesMigrated = workspaceResult.states;
      stats.tracesMigrated = workspaceResult.traces;

      // Migrate conversations
      const conversationResult = await this.migrateConversationsSafely(errors);
      stats.conversationsMigrated = conversationResult.conversations;
      stats.messagesMigrated = conversationResult.messages;

      // Archive legacy folders after successful migration
      const archiveResult = await this.archiver.archiveLegacyFolders();
      if (archiveResult.errors.length > 0) {
        errors.push(...archiveResult.errors);
      }

      // Record migration completion
      // Mark as archived if we archived anything, OR if archive folders already exist
      // (meaning a previous migration already archived them)
      const wasArchived = archiveResult.archived.length > 0 ||
        await this.archiver.archiveFoldersExist();
      await this.recordCompletion(startTime, stats, errors, wasArchived);

      const duration = Date.now() - startTime;
      const success = errors.length === 0;

      return this.createResult(true, success, stats, errors, startTime,
        success
          ? `Successfully migrated ${stats.workspacesMigrated} workspaces and ${stats.conversationsMigrated} conversations`
          : `Migration completed with ${errors.length} errors`);

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Migration failed: ${message}`);
      console.error('[LegacyMigrator] Fatal migration error:', error);

      return this.createResult(true, false, stats, errors, startTime, `Migration failed: ${message}`);
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private async ensureDirectories(): Promise<void> {
    await this.jsonlWriter.ensureDirectory();
    await this.jsonlWriter.ensureDirectory('workspaces');
    await this.jsonlWriter.ensureDirectory('conversations');
  }

  private async migrateWorkspacesSafely(errors: string[]): Promise<{
    workspaces: number;
    sessions: number;
    states: number;
    traces: number;
  }> {
    try {
      const result = await this.workspaceMigrator.migrate();
      errors.push(...result.errors);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Workspace migration failed: ${message}`);
      console.error('[LegacyMigrator] Workspace migration error:', error);
      return { workspaces: 0, sessions: 0, states: 0, traces: 0 };
    }
  }

  private async migrateConversationsSafely(errors: string[]): Promise<{
    conversations: number;
    messages: number;
  }> {
    try {
      const result = await this.conversationMigrator.migrate();
      errors.push(...result.errors);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Conversation migration failed: ${message}`);
      console.error('[LegacyMigrator] Conversation migration error:', error);
      return { conversations: 0, messages: 0 };
    }
  }

  private async recordCompletion(
    startTime: number,
    stats: MigrationStats,
    errors: string[],
    archived: boolean
  ): Promise<void> {
    // Preserve existing migratedFiles when recording completion
    const existingMigratedFiles = await this.statusTracker.getMigratedFiles();

    await this.statusTracker.save({
      completed: true,
      startedAt: startTime,
      completedAt: Date.now(),
      version: this.MIGRATION_VERSION,
      stats: { ...stats, errors },
      deviceId: this.jsonlWriter.getDeviceId(),
      errors,
      legacyArchived: archived,
      migratedFiles: existingMigratedFiles,
    });
  }

  private createResult(
    needed: boolean,
    success: boolean,
    stats: MigrationStats,
    errors: string[],
    startTime: number,
    message: string
  ): MigrationResult {
    return {
      needed,
      success,
      stats,
      errors,
      duration: Date.now() - startTime,
      message,
    };
  }
}
