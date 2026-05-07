import type { DataAdapter } from 'obsidian';
import type { CacheBlobMetadata, CacheBlobStore } from './CacheBlobStore';

interface VaultAdapterCacheBlobStoreOptions {
  adapter: DataAdapter;
  path: string;
}

/**
 * File-on-disk backing for cache.db. Used on mobile where IndexedDB durability
 * under iOS storage pressure is too weak for the 150+ MB blob. Behavior is
 * intentionally identical to the pre-CacheBlobStore SQLitePersistenceService
 * direct calls into vault.adapter.
 */
export class VaultAdapterCacheBlobStore implements CacheBlobStore {
  private readonly adapter: DataAdapter;
  private readonly path: string;

  constructor(opts: VaultAdapterCacheBlobStoreOptions) {
    this.adapter = opts.adapter;
    this.path = opts.path;
  }

  async read(): Promise<ArrayBuffer | null> {
    if (!(await this.adapter.exists(this.path))) {
      return null;
    }
    const data = await this.adapter.readBinary(this.path);
    if (data.byteLength === 0) {
      return null;
    }
    return data;
  }

  async write(buffer: ArrayBuffer): Promise<void> {
    const parent = this.path.substring(0, this.path.lastIndexOf('/'));
    if (parent && !(await this.adapter.exists(parent))) {
      await this.adapter.mkdir(parent);
    }
    await this.adapter.writeBinary(this.path, buffer);
  }

  async remove(): Promise<void> {
    try {
      await this.adapter.remove(this.path);
    } catch {
      // Idempotent — absent is success.
    }
  }

  async getMetadata(): Promise<CacheBlobMetadata | null> {
    if (!(await this.adapter.exists(this.path))) {
      return null;
    }
    const stat = await this.adapter.stat(this.path);
    if (!stat) return null;
    return { size: stat.size ?? 0, mtime: stat.mtime };
  }
}
