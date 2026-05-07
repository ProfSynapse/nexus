import type { App } from 'obsidian';

import type { CacheBlobStore } from './CacheBlobStore';
import { IndexedDBCacheBlobStore } from './IndexedDBCacheBlobStore';
import { VaultAdapterCacheBlobStore } from './VaultAdapterCacheBlobStore';
import { isDesktop } from '../../utils/platform';

export interface CacheBlobStoreFactoryOptions {
  app: App;
  /** Vault-relative path used by VaultAdapterCacheBlobStore on mobile. */
  vaultRelativePath: string;
  /** Stable per-vault, per-plugin-install key for the IDB record. */
  idbKey: string;
  /**
   * Override platform selection for tests. Production callers leave undefined
   * and rely on Obsidian Platform.isDesktop.
   */
  forceDesktop?: boolean;
}

export function createCacheBlobStore(opts: CacheBlobStoreFactoryOptions): CacheBlobStore {
  const useDesktop = opts.forceDesktop ?? isDesktop();
  if (useDesktop) {
    return new IndexedDBCacheBlobStore({ idbKey: opts.idbKey });
  }
  return new VaultAdapterCacheBlobStore({
    adapter: opts.app.vault.adapter,
    path: opts.vaultRelativePath
  });
}

/**
 * Compute a stable per-vault, per-plugin-install IDB key.
 *
 * Preferred source: Obsidian's runtime `app.appId`, which is install-stable per
 * vault (not in public types — accessed via cast). If absent (older Obsidian
 * builds, exotic embeddings), fall back to a non-cryptographic FNV-1a hash of
 * the absolute vault base path. Both branches are stable across restarts; the
 * appId branch is preferred because the absolute path can drift when a user
 * moves the vault folder.
 */
export function computeIdbKey(app: App, pluginManifestDir: string): string {
  const appWithId = app as App & { appId?: string };
  const vaultId = (typeof appWithId.appId === 'string' && appWithId.appId.length > 0)
    ? appWithId.appId
    : `path:${fnv1aHash32(safeBasePath(app))}`;
  return `${vaultId}:${pluginManifestDir}`;
}

function safeBasePath(app: App): string {
  // FileSystemAdapter.getBasePath() exists only on desktop. On mobile we
  // never use the path branch (factory selects VaultAdapter), but if this
  // function is invoked there for any reason we still want a stable string
  // input rather than a crash.
  const adapter = app.vault.adapter as { getBasePath?: () => string };
  if (typeof adapter.getBasePath === 'function') {
    try {
      const base = adapter.getBasePath();
      if (typeof base === 'string' && base.length > 0) return base;
    } catch {
      // fall through
    }
  }
  return app.vault.configDir;
}

function fnv1aHash32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
