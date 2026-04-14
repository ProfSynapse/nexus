import { App, normalizePath } from 'obsidian';

import { NamedLocks } from '../../../utils/AsyncLock';

const DEFAULT_MAX_SHARD_BYTES = 4 * 1024 * 1024;
const DEFAULT_SHARD_FILE_WIDTH = 6;
const SHARD_FILE_PATTERN = /^shard-(\d+)\.jsonl$/;
const TEXT_ENCODER = new TextEncoder();

export interface ShardedJsonlStreamStoreOptions {
  app: App;
  rootPath: string;
  maxShardBytes?: number;
  shardFileWidth?: number;
}

export interface ShardDescriptor {
  fileName: string;
  fullPath: string;
  index: number;
  relativePath: string;
  size: number;
  modTime: number | null;
}

export interface AppendEventResult<TEvent> {
  createdShard: boolean;
  event: TEvent;
  recordBytes: number;
  rotated: boolean;
  shard: ShardDescriptor;
}

export function formatShardFileName(index: number, width = DEFAULT_SHARD_FILE_WIDTH): string {
  return `shard-${String(index).padStart(width, '0')}.jsonl`;
}

export function parseShardFileName(fileName: string): number | null {
  const match = fileName.match(SHARD_FILE_PATTERN);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export class ShardedJsonlStreamStore<TEvent extends object> {
  private readonly app: App;
  private rootPath: string;
  private readonly maxShardBytes: number;
  private readonly shardFileWidth: number;
  private readonly locks = new NamedLocks();

  constructor(options: ShardedJsonlStreamStoreOptions) {
    this.app = options.app;
    this.rootPath = normalizePath(options.rootPath);
    this.maxShardBytes = Math.max(1, options.maxShardBytes ?? DEFAULT_MAX_SHARD_BYTES);
    this.shardFileWidth = Math.max(1, options.shardFileWidth ?? DEFAULT_SHARD_FILE_WIDTH);
  }

  setRootPath(rootPath: string): void {
    this.rootPath = normalizePath(rootPath);
  }

  getRootPath(): string {
    return this.rootPath;
  }

  getMaxShardBytes(): number {
    return this.maxShardBytes;
  }

  getStreamPath(relativeStreamPath: string): string {
    const normalizedRelative = this.normalizeRelativeStreamPath(relativeStreamPath);
    return normalizedRelative.length > 0
      ? normalizePath(`${this.rootPath}/${normalizedRelative}`)
      : this.rootPath;
  }

  getShardPath(relativeStreamPath: string, shardIndex: number): string {
    return normalizePath(
      `${this.getStreamPath(relativeStreamPath)}/${formatShardFileName(shardIndex, this.shardFileWidth)}`
    );
  }

  async ensureStreamDirectory(relativeStreamPath: string): Promise<string> {
    const streamPath = this.getStreamPath(relativeStreamPath);
    await this.ensureDirectory(streamPath);
    return streamPath;
  }

  async listShards(relativeStreamPath: string): Promise<ShardDescriptor[]> {
    const streamPath = this.getStreamPath(relativeStreamPath);

    if (!(await this.app.vault.adapter.exists(streamPath))) {
      return [];
    }

    const listing = await this.app.vault.adapter.list(streamPath);
    const descriptors: ShardDescriptor[] = [];

    for (const filePath of listing.files) {
      const normalizedFilePath = normalizePath(filePath);
      const parentPath = this.getParentPath(normalizedFilePath);
      const fileName = normalizedFilePath.slice(normalizedFilePath.lastIndexOf('/') + 1);
      const index = parseShardFileName(fileName);

      if (parentPath !== streamPath || index === null) {
        continue;
      }

      const stat = await this.app.vault.adapter.stat(normalizedFilePath);
      if (!stat) {
        continue;
      }

      descriptors.push({
        fileName,
        fullPath: normalizedFilePath,
        index,
        relativePath: this.buildRelativePath(relativeStreamPath, fileName),
        size: stat.size,
        modTime: stat.mtime ?? null
      });
    }

    return descriptors.sort((left, right) => left.index - right.index);
  }

  async appendEvent(relativeStreamPath: string, event: TEvent): Promise<AppendEventResult<TEvent>> {
    const streamPath = await this.ensureStreamDirectory(relativeStreamPath);

    return this.locks.acquire(streamPath, async () => {
      return this.appendEventToLockedStream(relativeStreamPath, event);
    });
  }

  async appendEvents(relativeStreamPath: string, events: TEvent[]): Promise<TEvent[]> {
    if (events.length === 0) {
      return [];
    }

    const streamPath = await this.ensureStreamDirectory(relativeStreamPath);

    return this.locks.acquire(streamPath, async () => {
      const appended: TEvent[] = [];
      let shards = await this.listShards(relativeStreamPath);
      let currentShard = shards.length > 0 ? shards[shards.length - 1] : null;

      for (const event of events) {
        const result = await this.appendEventToLockedStream(relativeStreamPath, event, currentShard);
        appended.push(result.event);
        currentShard = result.shard;
        if (result.createdShard) {
          shards = [...shards, result.shard];
        } else {
          shards = shards.map((shard) => shard.index === result.shard.index ? result.shard : shard);
        }
      }

      return appended;
    });
  }

  async readEvents(relativeStreamPath: string): Promise<TEvent[]> {
    const streamPath = this.getStreamPath(relativeStreamPath);

    return this.locks.acquire(streamPath, async () => {
      const shards = await this.listShards(relativeStreamPath);
      const events: TEvent[] = [];

      for (const shard of shards) {
        const content = await this.app.vault.adapter.read(shard.fullPath);
        events.push(...this.parseJsonlContent(content, shard.fullPath));
      }

      return events;
    });
  }

  private normalizeRelativeStreamPath(relativeStreamPath: string): string {
    return normalizePath(relativeStreamPath).replace(/^\/+|\/+$/g, '');
  }

  private getParentPath(filePath: string): string {
    const normalized = normalizePath(filePath);
    const lastSlashIndex = normalized.lastIndexOf('/');
    return lastSlashIndex === -1 ? '' : normalized.slice(0, lastSlashIndex);
  }

  private buildRelativePath(relativeStreamPath: string, fileName: string): string {
    const normalizedRelative = this.normalizeRelativeStreamPath(relativeStreamPath);
    return normalizedRelative.length > 0
      ? normalizePath(`${normalizedRelative}/${fileName}`)
      : fileName;
  }

  private async ensureDirectory(path: string): Promise<void> {
    const normalizedPath = normalizePath(path).replace(/\/+$/g, '');
    if (!normalizedPath) {
      return;
    }

    const segments = normalizedPath.split('/').filter(Boolean);
    let currentPath = '';

    for (const segment of segments) {
      currentPath = currentPath.length > 0 ? `${currentPath}/${segment}` : segment;
      if (!(await this.app.vault.adapter.exists(currentPath))) {
        await this.app.vault.adapter.mkdir(currentPath);
      }
    }
  }

  private parseJsonlContent(content: string, filePath: string): TEvent[] {
    if (!content.trim()) {
      return [];
    }

    const events: TEvent[] = [];
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        events.push(JSON.parse(trimmed) as TEvent);
      } catch {
        console.warn(`[ShardedJsonlStreamStore] Skipping malformed line in ${filePath}`);
      }
    }

    return events;
  }

  private getUtf8ByteLength(value: string): number {
    return TEXT_ENCODER.encode(value).byteLength;
  }

  private async appendEventToLockedStream(
    relativeStreamPath: string,
    event: TEvent,
    currentShardOverride: ShardDescriptor | null = null
  ): Promise<AppendEventResult<TEvent>> {
    const shards = currentShardOverride ? [currentShardOverride] : await this.listShards(relativeStreamPath);
    const currentShard = shards.length > 0 ? shards[shards.length - 1] : null;
    const serializedEvent = JSON.stringify(event);
    const serializedRecord = `${serializedEvent}\n`;
    const recordBytes = this.getUtf8ByteLength(serializedRecord);

    const shouldRotate =
      currentShard !== null &&
      currentShard.size > 0 &&
      currentShard.size + recordBytes > this.maxShardBytes;

    const targetIndex = currentShard === null
      ? 1
      : shouldRotate
        ? currentShard.index + 1
        : currentShard.index;

    const targetPath = this.getShardPath(relativeStreamPath, targetIndex);
    const existedBeforeWrite = await this.app.vault.adapter.exists(targetPath);

    if (existedBeforeWrite) {
      await this.app.vault.adapter.append(targetPath, serializedRecord);
    } else {
      await this.app.vault.adapter.write(targetPath, serializedRecord);
    }

    const stat = await this.app.vault.adapter.stat(targetPath);
    const fileName = formatShardFileName(targetIndex, this.shardFileWidth);

    return {
      createdShard: !existedBeforeWrite,
      event,
      recordBytes,
      rotated: shouldRotate,
      shard: {
        fileName,
        fullPath: targetPath,
        index: targetIndex,
        relativePath: this.buildRelativePath(relativeStreamPath, fileName),
        size: stat?.size ?? recordBytes,
        modTime: stat?.mtime ?? null
      }
    };
  }
}
