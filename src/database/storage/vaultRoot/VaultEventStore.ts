import { App, normalizePath } from 'obsidian';

import type { VaultRootResolution } from '../VaultRootResolver';
import {
  buildEventStreamPath,
  normalizeEventStreamId,
  parseEventStreamPath,
  type EventStreamCategory
} from './EventStreamUtilities';
import { ShardedJsonlStreamStore } from './ShardedJsonlStreamStore';

export type { EventStreamCategory } from './EventStreamUtilities';

export interface VaultEventStoreOptions {
  app: App;
  resolution: Pick<VaultRootResolution, 'resolvedPath' | 'dataPath' | 'maxShardBytes'>;
}

export interface VaultEventStorageManifest {
  manifestType: 'storage';
  schemaVersion: number;
  rootPath: string;
  maxShardBytes: number;
  updatedAt: number;
}

export interface VaultEventStoreShardSummary {
  fileName: string;
  relativePath: string;
  size: number;
  modTime: number | null;
}

export interface EventStreamHandle {
  category: EventStreamCategory;
  logicalId: string;
  relativeStreamPath: string;
  absoluteStreamPath: string;
  shardStore: ShardedJsonlStreamStore<object>;
}

export class VaultEventStore {
  private readonly app: App;
  private readonly rootPath: string;
  private readonly maxShardBytes: number;
  private readonly conversationStore: ShardedJsonlStreamStore<Record<string, unknown>>;
  private readonly workspaceStore: ShardedJsonlStreamStore<Record<string, unknown>>;
  private readonly taskStore: ShardedJsonlStreamStore<Record<string, unknown>>;

  constructor(options: VaultEventStoreOptions) {
    this.app = options.app;
    this.rootPath = normalizePath(options.resolution.dataPath);
    this.maxShardBytes = options.resolution.maxShardBytes;
    this.conversationStore = this.createShardStore<Record<string, unknown>>();
    this.workspaceStore = this.createShardStore<Record<string, unknown>>();
    this.taskStore = this.createShardStore<Record<string, unknown>>();
  }

  getRootPath(): string {
    return this.rootPath;
  }

  getMaxShardBytes(): number {
    return this.maxShardBytes;
  }

  getMetaRootPath(): string {
    return normalizePath(`${this.rootPath}/_meta`);
  }

  getMetaPath(fileName: string): string {
    return normalizePath(`${this.getMetaRootPath()}/${fileName}`);
  }

  getStorageManifestPath(): string {
    return this.getMetaPath('storage-manifest.json');
  }

  getMigrationManifestPath(): string {
    return this.getMetaPath('migration-manifest.json');
  }

  getMigrationReportPath(): string {
    return this.getMetaPath('migration-report.json');
  }

  async writeStorageManifest(updatedAt = Date.now()): Promise<VaultEventStorageManifest> {
    const manifest: VaultEventStorageManifest = {
      manifestType: 'storage',
      schemaVersion: 2,
      rootPath: this.rootPath,
      maxShardBytes: this.maxShardBytes,
      updatedAt
    };

    await this.writeMetaJson(this.getStorageManifestPath(), manifest);
    return manifest;
  }

  async appendEvent<TEvent extends object>(
    relativePath: string,
    event: TEvent
  ): Promise<TEvent> {
    const handle = this.resolveStreamHandle(relativePath);
    await handle.shardStore.appendEvent(handle.relativeStreamPath, event);
    return event;
  }

  async appendEvents<TEvent extends object>(
    relativePath: string,
    events: TEvent[]
  ): Promise<TEvent[]> {
    if (events.length === 0) {
      return [];
    }

    const handle = this.resolveStreamHandle(relativePath);
    return (await handle.shardStore.appendEvents(handle.relativeStreamPath, events)) as TEvent[];
  }

  async readEvents<TEvent extends object>(relativePath: string): Promise<TEvent[]> {
    const handle = this.resolveStreamHandle(relativePath);
    return (await handle.shardStore.readEvents(handle.relativeStreamPath)) as TEvent[];
  }

  async listFiles(category: EventStreamCategory): Promise<string[]> {
    const categoryRoot = this.getCategoryRootPath(category);
    if (!(await this.app.vault.adapter.exists(categoryRoot))) {
      return [];
    }

    const listing = await this.app.vault.adapter.list(categoryRoot);
    const files = new Set<string>();

    for (const folderPath of listing.folders) {
      const normalizedFolderPath = normalizePath(folderPath);
      if (this.getParentPath(normalizedFolderPath) !== categoryRoot) {
        continue;
      }

      const logicalId = normalizeEventStreamId(category, this.getPathLeaf(normalizedFolderPath));
      files.add(buildEventStreamPath(category, logicalId));
    }

    for (const filePath of listing.files) {
      const normalizedFilePath = normalizePath(filePath);
      if (this.getParentPath(normalizedFilePath) !== categoryRoot || !normalizedFilePath.endsWith('.jsonl')) {
        continue;
      }

      const logicalId = normalizeEventStreamId(
        category,
        this.getPathLeaf(normalizedFilePath).slice(0, -'.jsonl'.length)
      );
      files.add(buildEventStreamPath(category, logicalId));
    }

    return Array.from(files).sort();
  }

  async getFileModTime(relativePath: string): Promise<number | null> {
    const handle = this.resolveStreamHandle(relativePath);
    const shards = await handle.shardStore.listShards(handle.relativeStreamPath);
    let latestModTime: number | null = null;

    for (const shard of shards) {
      if (typeof shard.modTime !== 'number' || !Number.isFinite(shard.modTime)) {
        continue;
      }

      latestModTime = latestModTime === null ? shard.modTime : Math.max(latestModTime, shard.modTime);
    }

    return latestModTime;
  }

  async listShardSummaries(relativePath: string): Promise<VaultEventStoreShardSummary[]> {
    const handle = this.resolveStreamHandle(relativePath);
    const shards = await handle.shardStore.listShards(handle.relativeStreamPath);

    return shards.map(shard => ({
      fileName: shard.fileName,
      relativePath: shard.relativePath,
      size: shard.size,
      modTime: shard.modTime
    }));
  }

  async getFileSize(relativePath: string): Promise<number | null> {
    const handle = this.resolveStreamHandle(relativePath);
    const shards = await handle.shardStore.listShards(handle.relativeStreamPath);
    if (shards.length === 0) {
      return null;
    }

    return shards.reduce((total, shard) => total + shard.size, 0);
  }

  getConversationsRootPath(): string {
    return normalizePath(`${this.rootPath}/conversations`);
  }

  getWorkspacesRootPath(): string {
    return normalizePath(`${this.rootPath}/workspaces`);
  }

  getTasksRootPath(): string {
    return normalizePath(`${this.rootPath}/tasks`);
  }

  getConversationStream(conversationId: string): EventStreamHandle {
    return this.createStreamHandle('conversations', conversationId, this.conversationStore);
  }

  getWorkspaceStream(workspaceId: string): EventStreamHandle {
    return this.createStreamHandle('workspaces', workspaceId, this.workspaceStore);
  }

  getTaskStream(workspaceId: string): EventStreamHandle {
    return this.createStreamHandle('tasks', workspaceId, this.taskStore);
  }

  private createShardStore<TEvent extends object>(): ShardedJsonlStreamStore<TEvent> {
    return new ShardedJsonlStreamStore<TEvent>({
      app: this.app,
      rootPath: this.rootPath,
      maxShardBytes: this.maxShardBytes
    });
  }

  private createStreamHandle(
    category: EventStreamCategory,
    logicalId: string,
    shardStore: ShardedJsonlStreamStore<object>
  ): EventStreamHandle {
    const normalizedId = normalizeEventStreamId(category, logicalId);
    const relativeStreamPath = normalizePath(`${category}/${normalizedId}`);
    return {
      category,
      logicalId: normalizedId,
      relativeStreamPath,
      absoluteStreamPath: shardStore.getStreamPath(relativeStreamPath),
      shardStore
    };
  }

  private resolveStreamHandle(relativePath: string): EventStreamHandle {
    const parsed = parseEventStreamPath(relativePath);
    if (!parsed) {
      throw new Error(`Data folder requires a logical JSONL path, got: ${relativePath}`);
    }

    return this.createStreamHandle(parsed.category, parsed.logicalId, this.getShardStore(parsed.category));
  }

  private getShardStore(category: EventStreamCategory): ShardedJsonlStreamStore<object> {
    switch (category) {
      case 'conversations':
        return this.conversationStore;
      case 'workspaces':
        return this.workspaceStore;
      case 'tasks':
        return this.taskStore;
    }
  }

  private getCategoryRootPath(category: EventStreamCategory): string {
    switch (category) {
      case 'conversations':
        return this.getConversationsRootPath();
      case 'workspaces':
        return this.getWorkspacesRootPath();
      case 'tasks':
        return this.getTasksRootPath();
    }
  }

  private getPathLeaf(path: string): string {
    const normalized = normalizePath(path);
    const lastSlashIndex = normalized.lastIndexOf('/');
    return lastSlashIndex === -1 ? normalized : normalized.slice(lastSlashIndex + 1);
  }

  private getParentPath(path: string): string {
    const normalized = normalizePath(path);
    const lastSlashIndex = normalized.lastIndexOf('/');
    return lastSlashIndex === -1 ? '' : normalized.slice(0, lastSlashIndex);
  }

  private async writeMetaJson(path: string, value: object): Promise<void> {
    await this.ensureDirectory(this.getMetaRootPath());
    await this.app.vault.adapter.write(path, JSON.stringify(value, null, 2));
  }

  private async ensureDirectory(path: string): Promise<void> {
    if (!(await this.app.vault.adapter.exists(path))) {
      await this.app.vault.adapter.mkdir(path);
    }
  }

}
