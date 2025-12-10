/**
 * Location: src/database/sync/SyncCoordinator.ts
 *
 * Synchronization coordinator between JSONL (source of truth) and SQLite (cache).
 *
 * Thin orchestrator that delegates event application to:
 * - WorkspaceEventApplier: workspace, session, state, trace events
 * - ConversationEventApplier: conversation, message events
 *
 * Design Principles:
 * - Single Responsibility: Orchestration only
 * - Open/Closed: Add new event types via new appliers
 * - Dependency Injection: All dependencies passed to constructor
 */

import { BatchOperations } from '../optimizations/BatchOperations';
import {
  StorageEvent,
  WorkspaceEvent,
  ConversationEvent,
} from '../interfaces/StorageEvents';
import { WorkspaceEventApplier } from './WorkspaceEventApplier';
import { ConversationEventApplier } from './ConversationEventApplier';

// ============================================================================
// Interfaces
// ============================================================================

export interface IJSONLWriter {
  getDeviceId(): string;
  listFiles(category: 'workspaces' | 'conversations'): Promise<string[]>;
  readEvents<T extends StorageEvent>(file: string): Promise<T[]>;
  getEventsNotFromDevice<T extends StorageEvent>(
    file: string,
    deviceId: string,
    sinceTimestamp: number
  ): Promise<T[]>;
}

export interface ISQLiteCacheManager {
  getSyncState(deviceId: string): Promise<SyncState | null>;
  updateSyncState(deviceId: string, lastEventTimestamp: number, fileTimestamps: Record<string, number>): Promise<void>;
  isEventApplied(eventId: string): Promise<boolean>;
  markEventApplied(eventId: string): Promise<void>;
  run(sql: string, params?: any[]): Promise<any>;
  clearAllData(): Promise<void>;
  rebuildFTSIndexes(): Promise<void>;
  save(): Promise<void>;
}

export interface SyncState {
  deviceId: string;
  lastEventTimestamp: number;
  fileTimestamps: Record<string, number>;
}

export interface SyncResult {
  success: boolean;
  eventsApplied: number;
  eventsSkipped: number;
  errors: string[];
  duration: number;
  filesProcessed: string[];
  lastSyncTimestamp: number;
}

export interface SyncOptions {
  forceRebuild?: boolean;
  onProgress?: (phase: string, progress: number, total: number) => void;
  batchSize?: number;
}

// ============================================================================
// SyncCoordinator
// ============================================================================

export class SyncCoordinator {
  private jsonlWriter: IJSONLWriter;
  private sqliteCache: ISQLiteCacheManager;
  private deviceId: string;
  private workspaceApplier: WorkspaceEventApplier;
  private conversationApplier: ConversationEventApplier;

  constructor(jsonlWriter: IJSONLWriter, sqliteCache: ISQLiteCacheManager) {
    this.jsonlWriter = jsonlWriter;
    this.sqliteCache = sqliteCache;
    this.deviceId = jsonlWriter.getDeviceId();
    this.workspaceApplier = new WorkspaceEventApplier(sqliteCache);
    this.conversationApplier = new ConversationEventApplier(sqliteCache);
  }

  /**
   * Synchronize JSONL files to SQLite cache.
   */
  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let eventsApplied = 0;
    let eventsSkipped = 0;
    const filesProcessed: string[] = [];

    try {
      if (options.forceRebuild) {
        return this.fullRebuild(options);
      }

      const syncState = await this.sqliteCache.getSyncState(this.deviceId);
      const lastSync = syncState?.lastEventTimestamp ?? 0;

      // Process workspace files
      const workspaceResult = await this.processWorkspaceFiles(lastSync, options, errors);
      eventsApplied += workspaceResult.applied;
      eventsSkipped += workspaceResult.skipped;
      filesProcessed.push(...workspaceResult.files);

      // Process conversation files
      const conversationResult = await this.processConversationFiles(lastSync, options, errors);
      eventsApplied += conversationResult.applied;
      eventsSkipped += conversationResult.skipped;
      filesProcessed.push(...conversationResult.files);

      // Update sync state and save
      await this.sqliteCache.updateSyncState(this.deviceId, Date.now(), {});
      await this.sqliteCache.save();

      options.onProgress?.('Complete', 1, 1);

      return this.createResult(errors.length === 0, eventsApplied, eventsSkipped, errors, startTime, filesProcessed);
    } catch (error) {
      return this.createResult(false, eventsApplied, eventsSkipped, [...errors, `Sync failed: ${error}`], startTime, filesProcessed);
    }
  }

  /**
   * Full rebuild of SQLite from JSONL files.
   *
   * NOTE: Uses smaller batch size (25) to avoid OOM errors with sql.js asm.js version.
   * Saves after each file to prevent memory accumulation.
   */
  async fullRebuild(options: SyncOptions = {}): Promise<SyncResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let eventsApplied = 0;
    const filesProcessed: string[] = [];
    // Use smaller batch size for full rebuild to avoid OOM
    const batchSize = options.batchSize ?? 25;

    try {
      options.onProgress?.('Clearing cache', 0, 1);
      await this.sqliteCache.clearAllData();

      // Rebuild workspaces
      const workspaceResult = await this.rebuildWorkspaces(options, errors, batchSize);
      eventsApplied += workspaceResult.applied;
      filesProcessed.push(...workspaceResult.files);

      // Rebuild conversations
      const conversationResult = await this.rebuildConversations(options, errors, batchSize);
      eventsApplied += conversationResult.applied;
      filesProcessed.push(...conversationResult.files);

      // Rebuild FTS and save
      options.onProgress?.('Rebuilding search indexes', 0, 1);
      await this.sqliteCache.rebuildFTSIndexes();
      await this.sqliteCache.updateSyncState(this.deviceId, Date.now(), {});
      await this.sqliteCache.save();

      options.onProgress?.('Complete', 1, 1);

      console.log(`[SyncCoordinator] Rebuilt cache: ${eventsApplied} events from ${filesProcessed.length} files (${Date.now() - startTime}ms)`);

      return this.createResult(errors.length === 0, eventsApplied, 0, errors, startTime, filesProcessed);
    } catch (error) {
      console.error('[SyncCoordinator] Full rebuild failed:', error);
      return this.createResult(false, eventsApplied, 0, [...errors, `Rebuild failed: ${error}`], startTime, filesProcessed);
    }
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private async processWorkspaceFiles(
    lastSync: number,
    options: SyncOptions,
    errors: string[]
  ): Promise<{ applied: number; skipped: number; files: string[] }> {
    let applied = 0;
    let skipped = 0;
    const files: string[] = [];

    const workspaceFiles = await this.jsonlWriter.listFiles('workspaces');
    options.onProgress?.('Processing workspaces', 0, workspaceFiles.length);

    for (let i = 0; i < workspaceFiles.length; i++) {
      const file = workspaceFiles[i];
      try {
        const events = await this.jsonlWriter.getEventsNotFromDevice<WorkspaceEvent>(
          file, this.deviceId, lastSync
        );

        for (const event of events) {
          if (await this.sqliteCache.isEventApplied(event.id)) {
            skipped++;
            continue;
          }
          await this.workspaceApplier.apply(event);
          await this.sqliteCache.markEventApplied(event.id);
          applied++;
        }

        files.push(file);
        options.onProgress?.('Processing workspaces', i + 1, workspaceFiles.length);
      } catch (e) {
        errors.push(`Failed to process ${file}: ${e}`);
      }
    }

    return { applied, skipped, files };
  }

  private async processConversationFiles(
    lastSync: number,
    options: SyncOptions,
    errors: string[]
  ): Promise<{ applied: number; skipped: number; files: string[] }> {
    let applied = 0;
    let skipped = 0;
    const files: string[] = [];

    const conversationFiles = await this.jsonlWriter.listFiles('conversations');
    options.onProgress?.('Processing conversations', 0, conversationFiles.length);

    for (let i = 0; i < conversationFiles.length; i++) {
      const file = conversationFiles[i];
      try {
        const events = await this.jsonlWriter.getEventsNotFromDevice<ConversationEvent>(
          file, this.deviceId, lastSync
        );

        for (const event of events) {
          if (await this.sqliteCache.isEventApplied(event.id)) {
            skipped++;
            continue;
          }
          await this.conversationApplier.apply(event);
          await this.sqliteCache.markEventApplied(event.id);
          applied++;
        }

        files.push(file);
        options.onProgress?.('Processing conversations', i + 1, conversationFiles.length);
      } catch (e) {
        errors.push(`Failed to process ${file}: ${e}`);
      }
    }

    return { applied, skipped, files };
  }

  private async rebuildWorkspaces(
    options: SyncOptions,
    errors: string[],
    batchSize: number
  ): Promise<{ applied: number; files: string[] }> {
    let applied = 0;
    const files: string[] = [];

    const workspaceFiles = await this.jsonlWriter.listFiles('workspaces');
    options.onProgress?.('Processing workspaces', 0, workspaceFiles.length);

    for (let i = 0; i < workspaceFiles.length; i++) {
      const file = workspaceFiles[i];
      try {
        const events = await this.jsonlWriter.readEvents<WorkspaceEvent>(file);
        events.sort((a, b) => a.timestamp - b.timestamp);

        // Process in very small batches with delays to avoid OOM
        const result = await BatchOperations.executeBatch(
          events,
          async (event) => {
            await this.workspaceApplier.apply(event);
            await this.sqliteCache.markEventApplied(event.id);
          },
          { batchSize: Math.min(batchSize, 10), delayBetweenBatches: 10 }
        );

        applied += result.totalProcessed;
        if (result.errors.length > 0) {
          errors.push(...result.errors.map(e => `${file}: ${e.error.message}`));
        }

        files.push(file);
        options.onProgress?.('Processing workspaces', i + 1, workspaceFiles.length);

        // Save after each file to prevent memory accumulation (OOM prevention)
        await this.sqliteCache.save();
      } catch (e) {
        errors.push(`Failed to process ${file}: ${e}`);
      }
    }

    return { applied, files };
  }

  private async rebuildConversations(
    options: SyncOptions,
    errors: string[],
    batchSize: number
  ): Promise<{ applied: number; files: string[] }> {
    let applied = 0;
    const files: string[] = [];

    const conversationFiles = await this.jsonlWriter.listFiles('conversations');
    options.onProgress?.('Processing conversations', 0, conversationFiles.length);

    for (let i = 0; i < conversationFiles.length; i++) {
      const file = conversationFiles[i];
      try {
        const events = await this.jsonlWriter.readEvents<ConversationEvent>(file);
        events.sort((a, b) => a.timestamp - b.timestamp);

        const result = await BatchOperations.executeBatch(
          events,
          async (event) => {
            await this.conversationApplier.apply(event);
            await this.sqliteCache.markEventApplied(event.id);
          },
          { batchSize }
        );

        applied += result.totalProcessed;
        if (result.errors.length > 0) {
          errors.push(...result.errors.map(e => `${file}: ${e.error.message}`));
        }

        files.push(file);
        options.onProgress?.('Processing conversations', i + 1, conversationFiles.length);

        // Save after each file to prevent memory accumulation (OOM prevention)
        await this.sqliteCache.save();
      } catch (e) {
        errors.push(`Failed to process ${file}: ${e}`);
      }
    }

    return { applied, files };
  }

  private createResult(
    success: boolean,
    eventsApplied: number,
    eventsSkipped: number,
    errors: string[],
    startTime: number,
    filesProcessed: string[]
  ): SyncResult {
    return {
      success,
      eventsApplied,
      eventsSkipped,
      errors,
      duration: Date.now() - startTime,
      filesProcessed,
      lastSyncTimestamp: Date.now()
    };
  }
}
