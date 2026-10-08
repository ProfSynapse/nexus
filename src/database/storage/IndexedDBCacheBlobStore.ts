import type { CacheBlobMetadata, CacheBlobStore } from './CacheBlobStore';

interface IndexedDBCacheBlobStoreOptions {
  /** Stable per-vault, per-plugin-install key for the blob entry. */
  idbKey: string;
  /** Optional override for tests; defaults to window.activeWindow.indexedDB. */
  factory?: IDBFactory;
}

interface CacheBlobRecord {
  blob: ArrayBuffer;
  size: number;
  mtime: number;
}

/**
 * Desktop-only IndexedDB-backed CacheBlobStore. Lives in the Electron renderer's
 * storage area, NOT in any vault folder a third-party sync client (GDrive,
 * iCloud, Dropbox) follows. Structurally cloud-sync-immune.
 *
 * Schema: db `nexus-cache-blob-store` v1 / store `cache-blobs`, out-of-line
 * string keys. Single record per Nexus install (key = vaultId:pluginManifestDir).
 * Future schemas bump version + add migration in onupgradeneeded.
 */
export class IndexedDBCacheBlobStore implements CacheBlobStore {
  private static readonly DB_NAME = 'nexus-cache-blob-store';
  private static readonly STORE_NAME = 'cache-blobs';
  private static readonly DB_VERSION = 1;

  private readonly idbKey: string;
  private readonly factory: IDBFactory;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private currentDb: IDBDatabase | null = null;
  private connectionGeneration = 0;
  private persistRequested = false;

  constructor(opts: IndexedDBCacheBlobStoreOptions) {
    this.idbKey = opts.idbKey;
    const fallback = (window.activeWindow as { indexedDB?: IDBFactory }).indexedDB;
    const factory = Object.prototype.hasOwnProperty.call(opts, 'factory') ? opts.factory : fallback;
    if (!factory) {
      throw new Error('[IndexedDBCacheBlobStore] indexedDB is not available in this environment');
    }
    this.factory = factory;
  }

  async read(): Promise<ArrayBuffer | null> {
    const tx = await this.startTransaction('readonly');
    return new Promise<ArrayBuffer | null>((resolve, reject) => {
      tx.onabort = () => reject(tx.error ?? new Error('IDB read transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('IDB read transaction failed'));
      const req = tx.objectStore(IndexedDBCacheBlobStore.STORE_NAME).get(this.idbKey);
      req.onsuccess = () => {
        const value = req.result as CacheBlobRecord | undefined;
        if (!value || !value.blob || value.blob.byteLength === 0) {
          resolve(null);
          return;
        }
        resolve(value.blob);
      };
      req.onerror = () => reject(req.error ?? new Error('IDB read failed'));
    });
  }

  async write(buffer: ArrayBuffer): Promise<void> {
    const tx = await this.startTransaction('readwrite');
    const value: CacheBlobRecord = {
      blob: buffer,
      size: buffer.byteLength,
      mtime: Date.now()
    };
    return new Promise<void>((resolve, reject) => {
      tx.objectStore(IndexedDBCacheBlobStore.STORE_NAME).put(value, this.idbKey);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('IDB write transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('IDB write failed'));
    });
  }

  async remove(): Promise<void> {
    const tx = await this.startTransaction('readwrite');
    return new Promise<void>((resolve, reject) => {
      tx.objectStore(IndexedDBCacheBlobStore.STORE_NAME).delete(this.idbKey);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('IDB delete transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('IDB delete failed'));
    });
  }

  async getMetadata(): Promise<CacheBlobMetadata | null> {
    const tx = await this.startTransaction('readonly');
    return new Promise<CacheBlobMetadata | null>((resolve, reject) => {
      tx.onabort = () => reject(tx.error ?? new Error('IDB metadata transaction aborted'));
      tx.onerror = () => reject(tx.error ?? new Error('IDB metadata transaction failed'));
      const req = tx.objectStore(IndexedDBCacheBlobStore.STORE_NAME).get(this.idbKey);
      req.onsuccess = () => {
        const value = req.result as CacheBlobRecord | undefined;
        if (!value) {
          resolve(null);
          return;
        }
        resolve({ size: value.size, mtime: value.mtime });
      };
      req.onerror = () => reject(req.error ?? new Error('IDB metadata read failed'));
    });
  }

  /**
   * Test-only seam: drop the cached connection so the next call re-opens.
   * Useful for re-open-after-close coverage without exposing the IDBDatabase.
   */
  closeForTesting(): void {
    const pending = this.dbPromise;
    this.invalidateConnection();
    pending?.then(db => db.close()).catch(() => undefined);
  }

  /** A closed handle may be observed before its onclose event reaches us. */
  private async startTransaction(mode: IDBTransactionMode): Promise<IDBTransaction> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const db = await this.openDb();
      try {
        return db.transaction(IndexedDBCacheBlobStore.STORE_NAME, mode);
      } catch (err) {
        // Only transaction creation is retried. A failed request or an aborted
        // transaction may already have run and must be reported to the caller.
        if (!err || typeof err !== 'object' || !('name' in err) || err.name !== 'InvalidStateError') {
          throw err;
        }
        this.invalidateConnection(db);
        db.close();
        if (attempt !== 0) throw err;
      }
    }
    throw new Error('IDB transaction could not start');
  }

  private invalidateConnection(db?: IDBDatabase): void {
    if (db && this.currentDb !== db) return;
    this.connectionGeneration++;
    this.currentDb = null;
    this.dbPromise = null;
  }

  private openDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      const generation = ++this.connectionGeneration;
      this.dbPromise = this.openDbInternal(generation).catch(err => {
        if (this.connectionGeneration === generation) this.invalidateConnection();
        throw err;
      });
      // Best-effort persistence request; never branch behavior on outcome (C5).
      this.requestPersistOnce();
    }
    return this.dbPromise;
  }

  private openDbInternal(generation: number): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const req = this.factory.open(
        IndexedDBCacheBlobStore.DB_NAME,
        IndexedDBCacheBlobStore.DB_VERSION
      );
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IndexedDBCacheBlobStore.STORE_NAME)) {
          db.createObjectStore(IndexedDBCacheBlobStore.STORE_NAME);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        if (this.connectionGeneration !== generation) {
          db.close();
          reject(new Error('IDB open superseded by a newer connection'));
          return;
        }
        this.currentDb = db;
        db.onclose = () => {
          this.invalidateConnection(db);
        };
        db.onversionchange = () => {
          this.invalidateConnection(db);
          db.close();
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error('IDB open failed'));
      req.onblocked = () => reject(new Error('IDB open blocked by another connection'));
    });
  }

  private requestPersistOnce(): void {
    if (this.persistRequested) return;
    this.persistRequested = true;
    const nav = (window.activeWindow as { navigator?: { storage?: { persist?: () => Promise<boolean> } } }).navigator;
    const storage = nav?.storage;
    if (!storage || typeof storage.persist !== 'function') return;
    try {
      storage.persist()
        .then(persisted => {
          if (!persisted) {
            console.warn('[IndexedDBCacheBlobStore] navigator.storage.persist denied');
          }
        })
        .catch(err => {
          console.warn('[IndexedDBCacheBlobStore] navigator.storage.persist failed:', err);
        });
    } catch (err) {
      console.warn('[IndexedDBCacheBlobStore] navigator.storage.persist threw:', err);
    }
  }
}
