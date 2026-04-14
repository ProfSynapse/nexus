/**
 * Location: src/database/storage/StorageRouter.ts
 *
 * Centralizes the dual-path routing between VaultEventStore (vault-root sharded
 * storage) and legacy flat-file JSONL storage. JSONLWriter delegates all I/O
 * through this router so the branching logic lives in one place rather than
 * being duplicated across every read/write/list method.
 *
 * Related Files:
 * - src/database/storage/JSONLWriter.ts — the sole consumer of this router
 * - src/database/storage/vaultRoot/VaultEventStore.ts — vault-root backend
 */

import { App } from 'obsidian';
import { BaseStorageEvent, StorageEvent } from '../interfaces/StorageEvents';
import { NamedLocks } from '../../utils/AsyncLock';
import { VaultEventStore } from './vaultRoot/VaultEventStore';

// Re-export so JSONLWriter doesn't need to import these separately
export type EventCategory = 'conversations' | 'workspaces' | 'tasks';

export interface StorageRouterOptions {
  app: App;
  basePath: string;
  readBasePaths: string[];
  vaultEventStore: VaultEventStore | null;
  vaultEventStoreReadEnabled: boolean;
  locks: NamedLocks;
  /** Helper to normalize a logical relative path */
  normalizeLogicalRelativePath: (relativePath: string) => string;
  /** Helper to normalize stable logical paths (dedup-safe) */
  normalizeStableLogicalPath: (relativePath: string) => string;
  /** Helper to get path variants for legacy read resolution */
  getLogicalPathVariants: (relativePath: string) => string[];
  /** Helper to parse a relative path into category/fileName/fileStem */
  parseLogicalPath: (relativePath: string) => {
    category: EventCategory;
    fileName: string;
    fileStem: string;
  } | null;
  /** Helper to get the vault event logical path for a relative path */
  getVaultEventLogicalPath: (relativePath: string) => string | null;
  /** Helper to parse a subPath into a category name */
  getCategoryFromSubPath: (subPath: string) => EventCategory | null;
}

/**
 * Routes storage operations to either VaultEventStore or legacy flat-file
 * storage, centralizing the dual-path decision that was previously scattered
 * across every JSONLWriter method.
 *
 * Write operations are either/or: vault-root if available, otherwise legacy.
 * Read operations merge from both sources with event-ID deduplication.
 */
export class StorageRouter {
  private readonly app: App;
  private basePath: string;
  private readBasePaths: string[];
  private vaultEventStore: VaultEventStore | null;
  private vaultEventStoreReadEnabled: boolean;
  private readonly locks: NamedLocks;

  // Path helpers delegated from JSONLWriter
  private readonly normalizeLogicalRelativePath: (p: string) => string;
  private readonly normalizeStableLogicalPath: (p: string) => string;
  private readonly getLogicalPathVariants: (p: string) => string[];
  private readonly parseLogicalPath: StorageRouterOptions['parseLogicalPath'];
  private readonly getVaultEventLogicalPath: (p: string) => string | null;
  private readonly getCategoryFromSubPath: (s: string) => EventCategory | null;

  constructor(options: StorageRouterOptions) {
    this.app = options.app;
    this.basePath = options.basePath;
    this.readBasePaths = options.readBasePaths;
    this.vaultEventStore = options.vaultEventStore;
    this.vaultEventStoreReadEnabled = options.vaultEventStoreReadEnabled;
    this.locks = options.locks;

    this.normalizeLogicalRelativePath = options.normalizeLogicalRelativePath;
    this.normalizeStableLogicalPath = options.normalizeStableLogicalPath;
    this.getLogicalPathVariants = options.getLogicalPathVariants;
    this.parseLogicalPath = options.parseLogicalPath;
    this.getVaultEventLogicalPath = options.getVaultEventLogicalPath;
    this.getCategoryFromSubPath = options.getCategoryFromSubPath;
  }

  // -- Mutators for live reconfiguration (called by JSONLWriter setters) ------

  setBasePath(basePath: string): void {
    this.basePath = basePath;
  }

  setReadBasePaths(readBasePaths: string[]): void {
    this.readBasePaths = readBasePaths;
  }

  setVaultEventStore(store: VaultEventStore | null): void {
    this.vaultEventStore = store;
  }

  setVaultEventStoreReadEnabled(enabled: boolean): void {
    this.vaultEventStoreReadEnabled = enabled;
  }

  // -- Directory Management ---------------------------------------------------

  async ensureDirectory(subPath: string | undefined, basePath: string): Promise<void> {
    const category = subPath ? this.getCategoryFromSubPath(subPath) : null;

    if (category && this.vaultEventStore) {
      const vaultRoot = this.getVaultEventCategoryRoot(category);
      if (vaultRoot) {
        await this.ensureFolderExists(vaultRoot, subPath);
        return;
      }
    }

    const fullPath = subPath ? `${basePath}/${subPath}` : basePath;
    await this.ensureFolderExists(fullPath, subPath);
  }

  // -- Write Operations (either/or: vault-root wins if available) -------------

  async appendEvent<T extends BaseStorageEvent>(
    relativePath: string,
    event: T
  ): Promise<void> {
    const eventPath = this.getVaultEventLogicalPath(relativePath);
    if (eventPath && this.vaultEventStore) {
      await this.vaultEventStore.appendEvent(eventPath, event);
      return;
    }

    await this.appendToLegacyFile(relativePath, JSON.stringify(event) + '\n');
  }

  async appendEvents<T extends BaseStorageEvent>(
    relativePath: string,
    events: T[]
  ): Promise<void> {
    if (events.length === 0) {
      return;
    }

    const eventPath = this.getVaultEventLogicalPath(relativePath);
    if (eventPath && this.vaultEventStore) {
      await this.vaultEventStore.appendEvents(eventPath, events);
      return;
    }

    const lines = events.map(event => JSON.stringify(event)).join('\n') + '\n';
    await this.appendToLegacyFile(relativePath, lines);
  }

  // -- Read Operations (merge from both sources, dedup by event ID) -----------

  async readEvents<T extends StorageEvent>(relativePath: string): Promise<T[]> {
    const dedupedEvents = new Map<string, T>();

    // Source 1: vault-root (if enabled)
    await this.readFromVaultEventStore(relativePath, dedupedEvents);

    // Source 2: legacy flat-file paths
    await this.readFromLegacyPaths(relativePath, dedupedEvents);

    return Array.from(dedupedEvents.values());
  }

  // -- File Listing (merge from both sources) ---------------------------------

  async listFiles(subPath: string): Promise<string[]> {
    const files = new Set<string>();

    // Source 1: vault-root
    const category = this.getCategoryFromSubPath(subPath);
    if (category && this.vaultEventStore && this.vaultEventStoreReadEnabled) {
      const eventFiles = await this.vaultEventStore.listFiles(category);
      for (const logicalPath of eventFiles) {
        files.add(this.normalizeStableLogicalPath(logicalPath));
      }
    }

    // Source 2: legacy flat-file paths
    for (const readBasePath of this.readBasePaths) {
      const normalizedSubPath = this.normalizeLogicalRelativePath(subPath);
      const fullPath = `${readBasePath}/${normalizedSubPath}`;
      const exists = await this.app.vault.adapter.exists(fullPath);
      if (!exists) {
        continue;
      }

      const listing = await this.app.vault.adapter.list(fullPath);
      for (const filePath of listing.files) {
        if (filePath.endsWith('.jsonl')) {
          const logicalPath = filePath.replace(`${readBasePath}/`, '');
          files.add(this.normalizeStableLogicalPath(logicalPath));
        }
      }
    }

    return Array.from(files).sort();
  }

  // -- File Existence ---------------------------------------------------------

  async fileExists(relativePath: string): Promise<boolean> {
    const eventFiles = await this.resolveVaultEventReadablePaths(relativePath);
    if (eventFiles.length > 0) {
      return true;
    }

    const readablePaths = await this.resolveReadablePaths(relativePath);
    return readablePaths.length > 0;
  }

  // -- File Deletion ----------------------------------------------------------

  async deleteFile(relativePath: string, basePath: string): Promise<void> {
    const fullPath = `${basePath}/${relativePath}`;
    const exists = await this.app.vault.adapter.exists(fullPath);
    if (exists) {
      await this.app.vault.adapter.remove(fullPath);
    }
  }

  // -- File Metadata ----------------------------------------------------------

  async getFileModTime(relativePath: string): Promise<number | null> {
    if (this.vaultEventStore && this.vaultEventStoreReadEnabled) {
      const eventPath = this.getVaultEventLogicalPath(relativePath);
      if (eventPath) {
        const vaultStoreModTime = await this.vaultEventStore.getFileModTime(eventPath);
        if (vaultStoreModTime !== null) {
          return vaultStoreModTime;
        }
      }
    }

    const readablePaths = await this.resolveReadablePaths(relativePath);
    if (readablePaths.length === 0) {
      return null;
    }
    const stat = await this.app.vault.adapter.stat(readablePaths[0]);
    return stat?.mtime ?? null;
  }

  async getFileSize(relativePath: string): Promise<number | null> {
    if (this.vaultEventStore && this.vaultEventStoreReadEnabled) {
      const eventPath = this.getVaultEventLogicalPath(relativePath);
      if (eventPath) {
        const vaultStoreSize = await this.vaultEventStore.getFileSize(eventPath);
        if (vaultStoreSize !== null) {
          return vaultStoreSize;
        }
      }
    }

    const readablePaths = await this.resolveReadablePaths(relativePath);
    if (readablePaths.length === 0) {
      return null;
    }
    const stat = await this.app.vault.adapter.stat(readablePaths[0]);
    return stat?.size ?? null;
  }

  // -- Internal Helpers -------------------------------------------------------

  private getVaultEventCategoryRoot(category: EventCategory): string | null {
    if (!this.vaultEventStore) {
      return null;
    }

    switch (category) {
      case 'conversations':
        return this.vaultEventStore.getConversationsRootPath();
      case 'workspaces':
        return this.vaultEventStore.getWorkspacesRootPath();
      case 'tasks':
        return this.vaultEventStore.getTasksRootPath();
    }
  }

  private async ensureFolderExists(fullPath: string, contextSubPath: string | undefined): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(fullPath);
    if (!folder) {
      try {
        await this.app.vault.createFolder(fullPath);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (!errorMessage.includes('already exists')) {
          console.error(`[StorageRouter] Failed to ensure directory: ${contextSubPath ?? fullPath}`, error);
          throw new Error(`Failed to create directory: ${errorMessage}`);
        }
      }
    }
  }

  private async appendToLegacyFile(relativePath: string, content: string): Promise<void> {
    const fullPath = `${this.basePath}/${this.normalizeLogicalRelativePath(relativePath)}`;

    // Ensure parent directory exists
    const lastSlashIndex = fullPath.lastIndexOf('/');
    if (lastSlashIndex > 0) {
      const parentPath = fullPath.substring(0, lastSlashIndex);
      const relativeParent = parentPath.replace(this.basePath + '/', '');
      await this.ensureDirectory(relativeParent, this.basePath);
    }

    await this.locks.acquire(fullPath, async () => {
      const exists = await this.app.vault.adapter.exists(fullPath);

      if (exists) {
        // Blind append: always add newline prefix to ensure separation
        // May result in double newlines (harmless) but prevents merged lines (fatal)
        await this.app.vault.adapter.append(fullPath, '\n' + content);
      } else {
        await this.app.vault.adapter.write(fullPath, content);
      }
    });
  }

  private async readFromVaultEventStore<T extends StorageEvent>(
    relativePath: string,
    dedupedEvents: Map<string, T>
  ): Promise<void> {
    if (!this.vaultEventStore || !this.vaultEventStoreReadEnabled) {
      return;
    }

    const eventPath = this.getVaultEventLogicalPath(relativePath);
    if (!eventPath) {
      return;
    }

    const vaultEvents = await this.vaultEventStore.readEvents<T>(eventPath);
    for (const event of vaultEvents) {
      const eventId = typeof (event as { id?: unknown }).id === 'string'
        ? String((event as { id: string }).id)
        : JSON.stringify(event);
      if (!dedupedEvents.has(eventId)) {
        dedupedEvents.set(eventId, event);
      }
    }
  }

  private async readFromLegacyPaths<T extends StorageEvent>(
    relativePath: string,
    dedupedEvents: Map<string, T>
  ): Promise<void> {
    const readablePaths = await this.resolveReadablePaths(relativePath);
    for (const fullPath of readablePaths) {
      const content = await this.app.vault.adapter.read(fullPath);
      const lines = content.split('\n').filter(line => line.trim());

      for (let i = 0; i < lines.length; i++) {
        try {
          const event = JSON.parse(lines[i]) as T;
          const eventId = typeof (event as { id?: unknown }).id === 'string'
            ? String((event as { id: string }).id)
            : `${fullPath}:${i}:${lines[i]}`;
          if (!dedupedEvents.has(eventId)) {
            dedupedEvents.set(eventId, event);
          }
        } catch {
          continue;
        }
      }
    }
  }

  private async resolveVaultEventReadablePaths(relativePath: string): Promise<string[]> {
    const eventPath = this.getVaultEventLogicalPath(relativePath);
    if (!eventPath || !this.vaultEventStore || !this.vaultEventStoreReadEnabled) {
      return [];
    }

    const parsed = this.parseLogicalPath(relativePath);
    if (!parsed) {
      return [];
    }

    const files = await this.vaultEventStore.listFiles(parsed.category);
    return files.includes(eventPath) ? [eventPath] : [];
  }

  private async resolveReadablePaths(relativePath: string): Promise<string[]> {
    const readablePaths: string[] = [];
    const logicalPathVariants = this.getLogicalPathVariants(relativePath);

    for (const readBasePath of this.readBasePaths) {
      for (const logicalPath of logicalPathVariants) {
        const fullPath = `${readBasePath}/${logicalPath}`;
        if (await this.app.vault.adapter.exists(fullPath) && !readablePaths.includes(fullPath)) {
          readablePaths.push(fullPath);
        }
      }
    }
    return readablePaths;
  }
}
