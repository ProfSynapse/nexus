/**
 * Location: src/services/embeddings/adapter/AdapterStore.ts
 * Purpose: Persistence for the query-side embedding adapter.
 *
 * The adapter is a small (few hundred KB) artifact written under the synced
 * vault-root data folder (`<root>/data/embeddings/adapter.json`), so a model
 * trained on the desktop reaches other devices through normal vault sync.
 * SQLite is local-only and cannot carry it — hence a file, not a cache row.
 *
 * Reads are defensive: a missing or corrupt file yields the identity adapter
 * rather than throwing, so retrieval never breaks on a bad/partial sync. The
 * adapter is fully re-derivable (re-trainable), so a lost write self-heals on
 * the next dream cycle.
 */

import type { DataAdapter } from 'obsidian';
import { resolveVaultRoot } from '../../../database/storage/VaultRootResolver';
import { EmbeddingAdapter, AdapterSnapshot } from './EmbeddingAdapter';

type VaultSettings = Parameters<typeof resolveVaultRoot>[0];

export class AdapterStore {
  constructor(
    private readonly fs: DataAdapter,
    private readonly getSettings: () => VaultSettings,
    private readonly configDir?: string
  ) {}

  private dir(): string {
    const dataPath = resolveVaultRoot(this.getSettings(), { configDir: this.configDir }).dataPath;
    return `${dataPath}/embeddings`;
  }

  private file(): string {
    return `${this.dir()}/adapter.json`;
  }

  /** Load the persisted adapter, or identity when absent/unreadable. */
  async load(): Promise<EmbeddingAdapter> {
    try {
      const path = this.file();
      if (!(await this.fs.exists(path))) {
        return EmbeddingAdapter.identity();
      }
      const raw = await this.fs.read(path);
      const snapshot = JSON.parse(raw) as AdapterSnapshot;
      return EmbeddingAdapter.fromSnapshot(snapshot);
    } catch (error) {
      console.warn('[AdapterStore] Failed to load adapter; using identity.', error);
      return EmbeddingAdapter.identity();
    }
  }

  /** Persist an adapter snapshot (creates the directory on first write). */
  async save(adapter: EmbeddingAdapter): Promise<void> {
    const dir = this.dir();
    if (!(await this.fs.exists(dir))) {
      await this.fs.mkdir(dir);
    }
    await this.fs.write(this.file(), JSON.stringify(adapter.toSnapshot()));
  }
}
