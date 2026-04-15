/**
 * Location: src/database/storage/JSONLWriter.ts
 *
 * JSONL File Writer for Append-Only Storage
 *
 * This file provides sync-safe JSONL file operations using Obsidian's Vault API.
 * All writes are append-only to prevent sync conflicts across multiple devices.
 *
 * Design Principles:
 * - Append-only writes prevent sync conflicts
 * - Each line is a complete JSON event
 * - DeviceId tracks which device created each event
 * - Uses Obsidian Vault API (not Node.js fs) for compatibility
 * - Graceful error handling with logging
 *
 * File Structure:
 * - .nexus/workspaces/[workspaceId].jsonl - Workspace events
 * - .nexus/conversations/[conversationId].jsonl - Conversation events
 * - .nexus/sessions/[workspaceId]/[sessionId].jsonl - Session events
 *
 * Related Files:
 * - src/database/interfaces/StorageEvents.ts - Event type definitions
 * - src/database/services/cache/EntityCache.ts - In-memory cache layer
 * - src/database/storage/StorageRouter.ts - Dual-path routing (vault-root vs legacy)
 */

import { App, normalizePath } from 'obsidian';
import { StorageEvent, BaseStorageEvent } from '../interfaces/StorageEvents';
import { v4 as uuidv4 } from '../../utils/uuid';
import { NamedLocks } from '../../utils/AsyncLock';
import { VaultEventStore } from './vaultRoot/VaultEventStore';
import { StorageRouter } from './StorageRouter';

/**
 * Configuration options for JSONLWriter
 */
export interface JSONLWriterOptions {
  /** Obsidian app instance for vault operations */
  app: App;
  /** Base path for storage (default: '.nexus') */
  basePath: string;
  /** Ordered read roots for verified/fallback lookups */
  readBasePaths?: string[];
  /** Optional vault-root event store for sharded storage routing */
  vaultEventStore?: VaultEventStore | null;
}

/**
 * Optional callback invoked just before `JSONLWriter` writes to a logical
 * JSONL path. Used by `JsonlVaultWatcher` to suppress the echo modify
 * event that would otherwise round-trip back through `vault.on('modify')`
 * and trigger a pointless self-triggered sync.
 *
 * The callback receives the LOGICAL path (e.g. `conversations/conv_X.jsonl`),
 * not the physical shard path — the watcher maps it to `(category, streamId)`
 * and suppresses all shards for that stream for a short TTL.
 */
export type JSONLWriterBeforeWriteHook = (logicalPath: string) => void;

/**
 * JSONL Writer for sync-safe append-only storage
 *
 * Provides methods to append events to JSONL files and read them back.
 * Each event is tagged with a deviceId to track origin and enable
 * conflict-free sync across multiple devices.
 *
 * Usage:
 * ```typescript
 * const writer = new JSONLWriter({ app, basePath: '.nexus' });
 *
 * // Append an event
 * const event = await writer.appendEvent('workspaces/workspace-123.jsonl', {
 *   type: 'workspace_created',
 *   data: { id: 'workspace-123', name: 'My Workspace', ... }
 * });
 *
 * // Read all events
 * const events = await writer.readEvents('workspaces/workspace-123.jsonl');
 *
 * // Get events from other devices (for sync)
 * const remoteEvents = await writer.getEventsNotFromDevice(
 *   'workspaces/workspace-123.jsonl',
 *   writer.getDeviceId(),
 *   lastSyncTimestamp
 * );
 * ```
 */
export class JSONLWriter {
  private app: App;
  private basePath: string;
  private deviceId: string;
  private router: StorageRouter;
  private beforeWriteHook?: JSONLWriterBeforeWriteHook;
  private readonly deviceIdStorageKey = 'claudesidian-device-id';

  constructor(options: JSONLWriterOptions) {
    this.app = options.app;
    this.basePath = options.basePath;
    this.deviceId = this.getOrCreateDeviceId();

    const readBasePaths = this.normalizeReadBasePaths(options.readBasePaths ?? [options.basePath]);
    const vaultEventStore = options.vaultEventStore ?? null;

    this.router = new StorageRouter({
      app: this.app,
      basePath: this.basePath,
      readBasePaths,
      vaultEventStore,
      vaultEventStoreReadEnabled: true,
      locks: new NamedLocks(),
      normalizeLogicalRelativePath: this.normalizeLogicalRelativePath.bind(this),
      normalizeStableLogicalPath: this.normalizeStableLogicalPath.bind(this),
      getLogicalPathVariants: this.getLogicalPathVariants.bind(this),
      parseLogicalPath: this.parseLogicalPath.bind(this),
      getVaultEventLogicalPath: this.getVaultEventLogicalPath.bind(this),
      getCategoryFromSubPath: this.getCategoryFromSubPath.bind(this),
    });
  }

  setBasePath(basePath: string): void {
    this.basePath = basePath;
    this.router.setBasePath(basePath);
  }

  setReadBasePaths(basePaths: string[]): void {
    this.router.setReadBasePaths(this.normalizeReadBasePaths(basePaths));
  }

  setVaultEventStore(vaultEventStore: VaultEventStore | null): void {
    this.router.setVaultEventStore(vaultEventStore);
  }

  setVaultEventStoreReadEnabled(enabled: boolean): void {
    this.router.setVaultEventStoreReadEnabled(enabled);
  }

  /**
   * Register (or clear) a callback fired just before each append. Used by
   * the vault-event watcher to suppress echo modify events from the plugin's
   * own writes. Pass `undefined` to remove a previously-registered hook.
   */
  setBeforeWriteHook(hook: JSONLWriterBeforeWriteHook | undefined): void {
    this.beforeWriteHook = hook;
  }

  /**
   * Invoke the registered before-write hook if any. Swallows errors from
   * the hook so a misbehaving watcher never blocks a JSONL write.
   */
  private notifyBeforeWrite(logicalPath: string): void {
    if (!this.beforeWriteHook) {
      return;
    }
    try {
      this.beforeWriteHook(logicalPath);
    } catch (error) {
      console.error('[JSONLWriter] beforeWrite hook threw:', error);
    }
  }

  // ============================================================================
  // Device Management
  // ============================================================================

  /**
   * Get or create a unique device ID for this installation
   *
   * The device ID is stored in localStorage and persists across sessions.
   * This allows tracking which device created each event for sync resolution.
   *
   * @returns Persistent device UUID
   */
  private getOrCreateDeviceId(): string {
    const storedDeviceId = this.app.loadLocalStorage(this.deviceIdStorageKey) as unknown;
    if (typeof storedDeviceId === 'string' && storedDeviceId.length > 0) {
      return storedDeviceId;
    }

    const deviceId = uuidv4();
    this.app.saveLocalStorage(this.deviceIdStorageKey, deviceId);
    return deviceId;
  }

  /**
   * Get the current device ID
   *
   * @returns Device UUID for this installation
   */
  getDeviceId(): string {
    return this.deviceId;
  }

  // ============================================================================
  // Path Normalization (used by StorageRouter via bound callbacks)
  // ============================================================================

  private normalizeReadBasePaths(basePaths: string[]): string[] {
    const ordered = basePaths.length > 0 ? basePaths : [this.basePath];
    return Array.from(new Set(ordered));
  }

  private normalizeLogicalRelativePath(relativePath: string): string {
    return normalizePath(relativePath).replace(/^\/+|\/+$/g, '');
  }

  private parseLogicalPath(relativePath: string): {
    category: 'conversations' | 'workspaces' | 'tasks';
    fileName: string;
    fileStem: string;
  } | null {
    const normalizedPath = this.normalizeLogicalRelativePath(relativePath);
    const match = normalizedPath.match(/^(conversations|workspaces|tasks)\/(.+)\.jsonl$/);
    if (!match) {
      return null;
    }

    const fileName = `${match[2]}.jsonl`;
    return {
      category: match[1] as 'conversations' | 'workspaces' | 'tasks',
      fileName,
      fileStem: match[2]
    };
  }

  private normalizeConversationStem(fileStem: string): string {
    let normalized = this.normalizeLogicalRelativePath(fileStem);

    while (normalized.startsWith('conv_conv_')) {
      normalized = normalized.slice('conv_'.length);
    }

    return normalized;
  }

  private normalizeStableLogicalPath(relativePath: string): string {
    const parsed = this.parseLogicalPath(relativePath);
    if (!parsed) {
      return this.normalizeLogicalRelativePath(relativePath);
    }

    if (parsed.category !== 'conversations') {
      return `${parsed.category}/${parsed.fileName}`;
    }

    return `conversations/${this.normalizeConversationStem(parsed.fileStem)}.jsonl`;
  }

  private getLogicalPathVariants(relativePath: string): string[] {
    const parsed = this.parseLogicalPath(relativePath);
    if (!parsed) {
      return [this.normalizeLogicalRelativePath(relativePath)];
    }

    if (parsed.category !== 'conversations') {
      return [`${parsed.category}/${parsed.fileName}`];
    }

    const normalizedStem = this.normalizeConversationStem(parsed.fileStem);
    const variants = new Set<string>([`conversations/${normalizedStem}.jsonl`]);

    if (normalizedStem.startsWith('conv_')) {
      variants.add(`conversations/conv_${normalizedStem}.jsonl`);
    }

    return Array.from(variants);
  }

  private getVaultEventLogicalPath(relativePath: string): string | null {
    const parsed = this.parseLogicalPath(relativePath);
    if (!parsed) {
      return null;
    }

    if (parsed.category !== 'conversations') {
      return `${parsed.category}/${parsed.fileName}`;
    }

    return `conversations/${this.normalizeConversationStem(parsed.fileStem)}.jsonl`;
  }

  private getCategoryFromSubPath(subPath: string): 'conversations' | 'workspaces' | 'tasks' | null {
    const normalizedSubPath = this.normalizeLogicalRelativePath(subPath);
    if (normalizedSubPath === 'conversations' || normalizedSubPath === 'workspaces' || normalizedSubPath === 'tasks') {
      return normalizedSubPath;
    }
    return null;
  }

  // ============================================================================
  // Directory Management
  // ============================================================================

  /**
   * Ensure a directory exists, creating it if necessary
   *
   * @param subPath - Optional subdirectory path relative to basePath
   * @throws Error if directory creation fails
   */
  async ensureDirectory(subPath?: string): Promise<void> {
    await this.router.ensureDirectory(subPath, this.basePath);
  }

  // ============================================================================
  // Event Writing
  // ============================================================================

  /**
   * Append an event to a JSONL file (sync-safe)
   *
   * This method creates a complete event with id, deviceId, and timestamp,
   * then appends it as a single line to the JSONL file. If the file doesn't
   * exist, it will be created. Parent directories are created automatically.
   *
   * @param relativePath - File path relative to basePath (e.g., 'workspaces/ws-123.jsonl')
   * @param eventData - Event data without id, deviceId, timestamp (added automatically)
   * @returns The complete event with all metadata
   * @throws Error if append operation fails
   *
   * @example
   * ```typescript
   * const event = await writer.appendEvent('workspaces/ws-123.jsonl', {
   *   type: 'workspace_created',
   *   data: { id: 'ws-123', name: 'My Workspace', rootFolder: '/projects' }
   * });
   * ```
   */
  async appendEvent<T extends BaseStorageEvent>(
    relativePath: string,
    eventData: Omit<T, 'id' | 'deviceId' | 'timestamp'>
  ): Promise<T> {
    try {
      const event: T = {
        ...eventData,
        id: uuidv4(),
        deviceId: this.deviceId,
        timestamp: Date.now(),
      } as T;

      this.notifyBeforeWrite(relativePath);
      await this.router.appendEvent(relativePath, event);
      return event;
    } catch (error) {
      console.error(`[JSONLWriter] Failed to append event to ${relativePath}:`, error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to append event: ${message}`);
    }
  }

  /**
   * Append multiple events to a JSONL file in a single write (efficient for migration)
   *
   * Unlike appendEvent which reads/writes for each event, this batches all events
   * into a single file operation. Much faster for bulk operations.
   *
   * @param relativePath - File path relative to basePath
   * @param eventsData - Array of event data without id, deviceId, timestamp
   * @returns Array of complete events with all metadata
   */
  async appendEvents<T extends BaseStorageEvent>(
    relativePath: string,
    eventsData: Array<Omit<T, 'id' | 'deviceId' | 'timestamp'>>
  ): Promise<T[]> {
    if (eventsData.length === 0) {
      return [];
    }

    try {
      const events: T[] = eventsData.map(eventData => ({
        ...eventData,
        id: uuidv4(),
        deviceId: this.deviceId,
        timestamp: Date.now(),
      } as T));

      this.notifyBeforeWrite(relativePath);
      await this.router.appendEvents(relativePath, events);
      return events;
    } catch (error) {
      console.error(`[JSONLWriter] Failed to append ${eventsData.length} events to ${relativePath}:`, error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to append events: ${message}`);
    }
  }

  // ============================================================================
  // Event Reading
  // ============================================================================

  /**
   * Read all events from a JSONL file
   *
   * Parses each line as a JSON event. Invalid lines are logged and skipped.
   *
   * @param relativePath - File path relative to basePath
   * @returns Array of parsed events (empty if file doesn't exist)
   *
   * @example
   * ```typescript
   * const events = await writer.readEvents('workspaces/ws-123.jsonl');
   * console.log(`Found ${events.length} events`);
   * ```
   */
  async readEvents<T extends StorageEvent>(relativePath: string): Promise<T[]> {
    try {
      return await this.router.readEvents<T>(relativePath);
    } catch (error) {
      console.error(`[JSONLWriter] Failed to read events from ${relativePath}:`, error);
      return [];
    }
  }

  /**
   * Get events newer than a specific timestamp
   *
   * Useful for incremental sync operations.
   *
   * @param relativePath - File path relative to basePath
   * @param since - Unix timestamp (milliseconds)
   * @returns Array of events created after the timestamp
   *
   * @example
   * ```typescript
   * const lastSync = Date.now() - 3600000; // 1 hour ago
   * const recentEvents = await writer.getEventsSince('workspaces/ws-123.jsonl', lastSync);
   * ```
   */
  async getEventsSince<T extends StorageEvent>(
    relativePath: string,
    since: number
  ): Promise<T[]> {
    const events = await this.readEvents<T>(relativePath);
    return events.filter(event => event.timestamp > since);
  }

  /**
   * Get events from a specific device
   *
   * Useful for tracking what events were created locally.
   *
   * @param relativePath - File path relative to basePath
   * @param deviceId - Target device ID
   * @returns Array of events from the specified device
   */
  async getEventsFromDevice<T extends StorageEvent>(
    relativePath: string,
    deviceId: string
  ): Promise<T[]> {
    const events = await this.readEvents<T>(relativePath);
    return events.filter(event => event.deviceId === deviceId);
  }

  /**
   * Get events NOT from a specific device (for sync)
   *
   * This is the primary method for detecting remote changes during sync.
   * Returns events created by other devices, optionally filtered by timestamp.
   *
   * @param relativePath - File path relative to basePath
   * @param deviceId - Current device ID (to exclude)
   * @param since - Optional timestamp to filter recent events
   * @returns Array of events from other devices
   *
   * @example
   * ```typescript
   * // Get all remote changes since last sync
   * const remoteChanges = await writer.getEventsNotFromDevice(
   *   'workspaces/ws-123.jsonl',
   *   writer.getDeviceId(),
   *   lastSyncTimestamp
   * );
   * ```
   */
  async getEventsNotFromDevice<T extends StorageEvent>(
    relativePath: string,
    deviceId: string,
    since?: number
  ): Promise<T[]> {
    let events = await this.readEvents<T>(relativePath);
    events = events.filter(event => event.deviceId !== deviceId);
    if (since !== undefined) {
      events = events.filter(event => event.timestamp > since);
    }
    return events;
  }

  // ============================================================================
  // File Management
  // ============================================================================

  /**
   * List all JSONL files in a subdirectory
   *
   * @param subPath - Subdirectory path relative to basePath
   * @returns Array of relative file paths
   *
   * @example
   * ```typescript
   * const workspaceFiles = await writer.listFiles('workspaces');
   * // Returns: ['workspaces/ws-1.jsonl', 'workspaces/ws-2.jsonl']
   * ```
   */
  async listFiles(subPath: string): Promise<string[]> {
    try {
      return await this.router.listFiles(subPath);
    } catch (error) {
      console.error(`[JSONLWriter] Failed to list files in ${subPath}:`, error);
      return [];
    }
  }

  /**
   * Check if a JSONL file exists
   *
   * @param relativePath - File path relative to basePath
   * @returns True if file exists
   */
  async fileExists(relativePath: string): Promise<boolean> {
    return this.router.fileExists(relativePath);
  }

  /**
   * Delete a JSONL file
   *
   * Warning: This operation cannot be undone. Consider soft deletes using
   * deletion events instead.
   *
   * @param relativePath - File path relative to basePath
   * @throws Error if deletion fails
   */
  async deleteFile(relativePath: string): Promise<void> {
    try {
      await this.router.deleteFile(relativePath, this.basePath);
    } catch (error) {
      console.error(`[JSONLWriter] Failed to delete file ${relativePath}:`, error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to delete file: ${message}`);
    }
  }

  /**
   * Get file modification time
   *
   * @param relativePath - File path relative to basePath
   * @returns Unix timestamp (milliseconds) or null if file doesn't exist
   */
  async getFileModTime(relativePath: string): Promise<number | null> {
    try {
      return await this.router.getFileModTime(relativePath);
    } catch (error) {
      console.error(`[JSONLWriter] Failed to get mod time for ${relativePath}:`, error);
      return null;
    }
  }

  /**
   * Get file size in bytes
   *
   * @param relativePath - File path relative to basePath
   * @returns File size in bytes or null if file doesn't exist
   */
  async getFileSize(relativePath: string): Promise<number | null> {
    try {
      return await this.router.getFileSize(relativePath);
    } catch (error) {
      console.error(`[JSONLWriter] Failed to get size for ${relativePath}:`, error);
      return null;
    }
  }

  /**
   * Get statistics about a JSONL file
   *
   * @param relativePath - File path relative to basePath
   * @returns File statistics or null if file doesn't exist
   */
  async getFileStats(relativePath: string): Promise<{
    exists: boolean;
    size: number;
    modTime: number;
    eventCount: number;
  } | null> {
    try {
      const exists = await this.fileExists(relativePath);
      if (!exists) {
        return null;
      }

      const size = await this.getFileSize(relativePath);
      const modTime = await this.getFileModTime(relativePath);
      const events = await this.readEvents(relativePath);

      return {
        exists: true,
        size: size || 0,
        modTime: modTime || 0,
        eventCount: events.length,
      };
    } catch (error) {
      console.error(`[JSONLWriter] Failed to get stats for ${relativePath}:`, error);
      return null;
    }
  }
}
