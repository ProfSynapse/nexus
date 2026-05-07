/**
 * Persistence backend for the SQLite cache.db serialized blob.
 *
 * Two implementations: VaultAdapterCacheBlobStore (mobile, file-on-disk via
 * vault.adapter) and IndexedDBCacheBlobStore (desktop, sync-immune via IDB).
 * Selected by CacheBlobStoreFactory based on Platform.isDesktop.
 *
 * Error contract: implementations throw on unrecoverable failure (e.g., IDB
 * transaction abort). Callers (SQLitePersistenceService) catch and route to
 * recreateCorruptedDatabase. Implementations MUST distinguish "blob absent"
 * (return null from read) from "blob present but unreadable" (throw).
 */
export interface CacheBlobStore {
  /**
   * Read the persisted SQLite blob. Returns null if the blob is absent
   * (first launch, post-clear, post-migration-from-empty). Throws on
   * unrecoverable backend failure.
   */
  read(): Promise<ArrayBuffer | null>;

  /**
   * Write the SQLite blob, replacing any existing blob atomically (or as
   * close to atomically as the backend permits). Throws on failure.
   */
  write(buffer: ArrayBuffer): Promise<void>;

  /**
   * Remove the persisted blob. Idempotent — returns successfully if the
   * blob was already absent.
   */
  remove(): Promise<void>;

  /**
   * Best-effort metadata for diagnostics. Returns null if blob absent or
   * the backend cannot produce metadata cheaply. MUST NOT read the blob
   * bytes — return null rather than load to measure.
   */
  getMetadata(): Promise<CacheBlobMetadata | null>;
}

export interface CacheBlobMetadata {
  /** Size in bytes. */
  size: number;
  /** Last-write timestamp in epoch ms. May be approximate. */
  mtime?: number;
}
