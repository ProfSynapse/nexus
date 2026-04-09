import { App, normalizePath } from 'obsidian';

import type { CanonicalVaultRootResolution } from '../CanonicalVaultRootResolver';
import { ShardedJsonlStreamStore } from './ShardedJsonlStreamStore';

export type CanonicalStreamCategory = 'conversations' | 'workspaces' | 'tasks';

export interface CanonicalNexusEventStoreOptions {
  app: App;
  resolution: Pick<CanonicalVaultRootResolution, 'resolvedRootPath' | 'maxShardBytes'>;
}

export interface CanonicalStreamHandle {
  category: CanonicalStreamCategory;
  logicalId: string;
  relativeStreamPath: string;
  absoluteStreamPath: string;
  shardStore: ShardedJsonlStreamStore<object>;
}

export class CanonicalNexusEventStore {
  private readonly app: App;
  private readonly rootPath: string;
  private readonly maxShardBytes: number;
  private readonly conversationStore: ShardedJsonlStreamStore<Record<string, unknown>>;
  private readonly workspaceStore: ShardedJsonlStreamStore<Record<string, unknown>>;
  private readonly taskStore: ShardedJsonlStreamStore<Record<string, unknown>>;

  constructor(options: CanonicalNexusEventStoreOptions) {
    this.app = options.app;
    this.rootPath = normalizePath(options.resolution.resolvedRootPath);
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

  async listFiles(category: CanonicalStreamCategory): Promise<string[]> {
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

      const logicalId = this.normalizeLogicalId(category, this.getPathLeaf(normalizedFolderPath));
      files.add(this.buildLogicalPath(category, logicalId));
    }

    for (const filePath of listing.files) {
      const normalizedFilePath = normalizePath(filePath);
      if (this.getParentPath(normalizedFilePath) !== categoryRoot || !normalizedFilePath.endsWith('.jsonl')) {
        continue;
      }

      const logicalId = this.normalizeLogicalId(
        category,
        this.getPathLeaf(normalizedFilePath).slice(0, -'.jsonl'.length)
      );
      files.add(this.buildLogicalPath(category, logicalId));
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

  getConversationStream(conversationId: string): CanonicalStreamHandle {
    return this.createStreamHandle('conversations', conversationId, this.conversationStore);
  }

  getWorkspaceStream(workspaceId: string): CanonicalStreamHandle {
    return this.createStreamHandle('workspaces', workspaceId, this.workspaceStore);
  }

  getTaskStream(workspaceId: string): CanonicalStreamHandle {
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
    category: CanonicalStreamCategory,
    logicalId: string,
    shardStore: ShardedJsonlStreamStore<object>
  ): CanonicalStreamHandle {
    const normalizedId = this.normalizeLogicalId(category, logicalId);
    const relativeStreamPath = normalizePath(`${category}/${normalizedId}`);
    return {
      category,
      logicalId: normalizedId,
      relativeStreamPath,
      absoluteStreamPath: shardStore.getStreamPath(relativeStreamPath),
      shardStore
    };
  }

  private resolveStreamHandle(relativePath: string): CanonicalStreamHandle {
    const parsed = this.parseLogicalPath(relativePath);
    if (!parsed) {
      throw new Error(`Canonical storage requires a logical JSONL path, got: ${relativePath}`);
    }

    return this.createStreamHandle(parsed.category, parsed.logicalId, this.getShardStore(parsed.category));
  }

  private getShardStore(category: CanonicalStreamCategory): ShardedJsonlStreamStore<object> {
    switch (category) {
      case 'conversations':
        return this.conversationStore;
      case 'workspaces':
        return this.workspaceStore;
      case 'tasks':
        return this.taskStore;
    }
  }

  private parseLogicalPath(relativePath: string): {
    category: CanonicalStreamCategory;
    logicalId: string;
  } | null {
    const normalizedPath = normalizePath(relativePath).replace(/^\/+|\/+$/g, '');
    const match = normalizedPath.match(/^(conversations|workspaces|tasks)\/(.+)\.jsonl$/);
    if (!match) {
      return null;
    }

    return {
      category: match[1] as CanonicalStreamCategory,
      logicalId: this.normalizeLogicalId(match[1] as CanonicalStreamCategory, match[2])
    };
  }

  private getCategoryRootPath(category: CanonicalStreamCategory): string {
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

  private buildLogicalPath(category: CanonicalStreamCategory, logicalId: string): string {
    return normalizePath(`${category}/${logicalId}.jsonl`);
  }

  private normalizeLogicalId(category: CanonicalStreamCategory, logicalId: string): string {
    if (category !== 'conversations') {
      return this.normalizeLogicalIdSegments(logicalId);
    }

    return this.normalizeConversationLogicalId(logicalId);
  }

  private normalizeConversationLogicalId(logicalId: string): string {
    let normalized = this.normalizeLogicalIdSegments(logicalId);

    while (normalized.startsWith('conv_conv_')) {
      normalized = normalized.slice('conv_'.length);
    }

    return normalized;
  }

  private normalizeLogicalIdSegments(logicalId: string): string {
    const normalizedId = normalizePath(logicalId).replace(/^\/+|\/+$/g, '');
    if (!normalizedId) {
      throw new Error('Canonical stream logical ID cannot be empty.');
    }

    return normalizedId;
  }
}
