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
 */

import { App } from 'obsidian';
import { StorageEvent, BaseStorageEvent } from '../interfaces/StorageEvents';
import { v4 as uuidv4 } from '../../utils/uuid';
import { NamedLocks } from '../../utils/AsyncLock';

/** Fork: Max file size (bytes) before readEvents falls back to streaming readline (50 MB) */
const MAX_FILE_SIZE_FOR_IN_MEMORY_READ = 50 * 1024 * 1024;

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
}

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
  private readBasePaths: string[];
  private deviceId: string;
  private locks: NamedLocks;
  private readonly deviceIdStorageKey = 'claudesidian-device-id';

  constructor(options: JSONLWriterOptions) {
    this.app = options.app;
    this.basePath = options.basePath;
    this.readBasePaths = this.normalizeReadBasePaths(options.readBasePaths ?? [options.basePath]);
    this.deviceId = this.getOrCreateDeviceId();
    this.locks = new NamedLocks();
  }

  setBasePath(basePath: string): void {
    this.basePath = basePath;
  }

  setReadBasePaths(basePaths: string[]): void {
    this.readBasePaths = this.normalizeReadBasePaths(basePaths);
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

  private normalizeReadBasePaths(basePaths: string[]): string[] {
    const ordered = basePaths.length > 0 ? basePaths : [this.basePath];
    return Array.from(new Set(ordered));
  }

  private buildFullPath(basePath: string, relativePath: string): string {
    return `${basePath}/${relativePath}`;
  }

  private async resolveReadablePaths(relativePath: string): Promise<string[]> {
    const readablePaths: string[] = [];
    for (const readBasePath of this.readBasePaths) {
      const fullPath = this.buildFullPath(readBasePath, relativePath);
      if (await this.app.vault.adapter.exists(fullPath)) {
        readablePaths.push(fullPath);
      }
    }
    return readablePaths;
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
    const fullPath = subPath ? `${this.basePath}/${subPath}` : this.basePath;
    const folder = this.app.vault.getAbstractFileByPath(fullPath);

    if (!folder) {
      try {
        await this.app.vault.createFolder(fullPath);
      } catch (error) {
        // Ignore "already exists" errors (race condition with metadata cache)
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (!errorMessage.includes('already exists')) {
          console.error(`[JSONLWriter] Failed to ensure directory: ${subPath}`, error);
          throw new Error(`Failed to create directory: ${errorMessage}`);
        }
        // Folder exists on disk but wasn't in metadata cache - that's fine
      }
    }
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
      const fullPath = `${this.basePath}/${relativePath}`;

      // Create the full event with metadata
      const event: T = {
        ...eventData,
        id: uuidv4(),
        deviceId: this.deviceId,
        timestamp: Date.now(),
      } as T;

      const line = JSON.stringify(event) + '\n';

      // Ensure parent directory exists
      const lastSlashIndex = fullPath.lastIndexOf('/');
      if (lastSlashIndex > 0) {
        const parentPath = fullPath.substring(0, lastSlashIndex);
        const relativeParent = parentPath.replace(this.basePath + '/', '');
        await this.ensureDirectory(relativeParent);
      }

      // Use adapter methods for hidden folder support (.nexus/)
      // Use lock to prevent race conditions
      await this.locks.acquire(fullPath, async () => {
        const exists = await this.app.vault.adapter.exists(fullPath);

        if (exists) {
          // Use atomic append (DataAdapter always has append method)
          // Blind append: Safety first -> always add newline prefix to ensure separation
          // This might result in double newlines (harmless), but prevents merged lines (fatal)
          await this.app.vault.adapter.append(fullPath, '\n' + line);
        } else {
          // Create new file with this line
          await this.app.vault.adapter.write(fullPath, line);
        }
      });

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
      const fullPath = `${this.basePath}/${relativePath}`;

      // Create all events with metadata
      const events: T[] = eventsData.map(eventData => ({
        ...eventData,
        id: uuidv4(),
        deviceId: this.deviceId,
        timestamp: Date.now(),
      } as T));

      const lines = events.map(event => JSON.stringify(event)).join('\n') + '\n';

      // Ensure parent directory exists
      const lastSlashIndex = fullPath.lastIndexOf('/');
      if (lastSlashIndex > 0) {
        const parentPath = fullPath.substring(0, lastSlashIndex);
        const relativeParent = parentPath.replace(this.basePath + '/', '');
        await this.ensureDirectory(relativeParent);
      }

      // Use adapter methods for hidden folder support (.nexus/)
      // Use lock to prevent race conditions
      await this.locks.acquire(fullPath, async () => {
        const exists = await this.app.vault.adapter.exists(fullPath);

        if (exists) {
          // Use atomic append (DataAdapter always has append method)
          // Blind append: Safety first -> always add newline prefix
          await this.app.vault.adapter.append(fullPath, '\n' + lines);
        } else {
          // Create new file with all lines
          await this.app.vault.adapter.write(fullPath, lines);
        }
      });

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
      const readablePaths = await this.resolveReadablePaths(relativePath);
      if (readablePaths.length === 0) {
        return [];
      }

      const dedupedEvents = new Map<string, T>();
      for (const fullPath of readablePaths) {
        // Fork: Fall back to streaming readline for files >50 MB (avoids V8 string length crash)
        const stat = await this.app.vault.adapter.stat?.(fullPath);
        const fileSize = stat?.size ?? 0;

        let fileEvents: T[];
        if (fileSize > MAX_FILE_SIZE_FOR_IN_MEMORY_READ) {
          fileEvents = await this.readEventsStreaming<T>(fullPath);
        } else {
          const content = await this.app.vault.adapter.read(fullPath);
          const lines = content.split('\n').filter(line => line.trim());
          fileEvents = [];
          for (const line of lines) {
            try {
              fileEvents.push(JSON.parse(line) as T);
            } catch {
              continue;
            }
          }
        }

        for (let i = 0; i < fileEvents.length; i++) {
          const event = fileEvents[i];
          const eventId = typeof (event as { id?: unknown }).id === 'string'
            ? String((event as { id: string }).id)
            : `${fullPath}:${i}:${JSON.stringify(event)}`;
          if (!dedupedEvents.has(eventId)) {
            dedupedEvents.set(eventId, event);
          }
        }
      }

      return Array.from(dedupedEvents.values());
    } catch (error) {
      console.error(`[JSONLWriter] Failed to read events from ${relativePath}:`, error);
      return [];
    }
  }

  /**
   * Fork: Read events from a large JSONL file using Node.js readline streaming.
   * Avoids loading the entire file into a single string (V8 string length limit).
   *
   * @param absolutePath - Absolute filesystem path to the .jsonl file
   */
  private readEventsStreaming<T extends StorageEvent>(absolutePath: string): Promise<T[]> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const readline = require('readline') as typeof import('readline');

    return new Promise((resolve, reject) => {
      const events: T[] = [];
      const rl = readline.createInterface({
        input: fs.createReadStream(absolutePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });

      rl.on('line', (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          events.push(JSON.parse(trimmed) as T);
        } catch {
          // skip malformed lines
        }
      });

      rl.on('close', () => resolve(events));
      rl.on('error', reject);
    });
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
      const files = new Set<string>();

      for (const readBasePath of this.readBasePaths) {
        const fullPath = `${readBasePath}/${subPath}`;
        const exists = await this.app.vault.adapter.exists(fullPath);
        if (!exists) {
          continue;
        }

        const listing = await this.app.vault.adapter.list(fullPath);
        for (const filePath of listing.files) {
          if (filePath.endsWith('.jsonl')) {
            files.add(filePath.replace(`${readBasePath}/`, ''));
          }
        }
      }

      return Array.from(files).sort();
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
    const readablePaths = await this.resolveReadablePaths(relativePath);
    return readablePaths.length > 0;
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
      const fullPath = `${this.basePath}/${relativePath}`;
      // Use adapter for hidden folder support (.nexus/)
      const exists = await this.app.vault.adapter.exists(fullPath);
      if (exists) {
        await this.app.vault.adapter.remove(fullPath);
      }
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
      const readablePaths = await this.resolveReadablePaths(relativePath);
      if (readablePaths.length === 0) {
        return null;
      }
      const stat = await this.app.vault.adapter.stat(readablePaths[0]);
      return stat?.mtime ?? null;
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
      const readablePaths = await this.resolveReadablePaths(relativePath);
      if (readablePaths.length === 0) {
        return null;
      }
      const stat = await this.app.vault.adapter.stat(readablePaths[0]);
      return stat?.size ?? null;
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
