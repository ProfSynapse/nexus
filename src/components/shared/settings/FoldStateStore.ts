/**
 * Remembers which settings folds are open, per device.
 *
 * Stored with `app.saveLocalStorage` (vault-scoped, never synced) rather than in
 * data.json: a synced key would make every other device treat each fold toggle
 * as a settings change that needs a reload. Defaults and Chat settings keep
 * separate lists so opening a fold in one does not open it in the other.
 */

export type FoldSurface = 'defaults' | 'chat';

interface StoredFoldState {
  v: 1;
  defaults: string[];
  chat: string[];
}

/** The two App methods this store needs; keeps tests free of a full App. */
export interface LocalStorageHost {
  loadLocalStorage?(key: string): unknown;
  saveLocalStorage?(key: string, data: unknown): void;
}

export const FOLD_STATE_STORAGE_KEY = 'nexus-settings-folds';

function emptyState(): StoredFoldState {
  return { v: 1, defaults: [], chat: [] };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export class FoldStateStore {
  constructor(private readonly host: LocalStorageHost) {}

  isOpen(surface: FoldSurface, id: string): boolean {
    return this.read()[surface].includes(id);
  }

  setOpen(surface: FoldSurface, id: string, open: boolean): void {
    const state = this.read();
    const ids = state[surface].filter(item => item !== id);
    if (open) ids.push(id);
    state[surface] = ids;
    try {
      this.host.saveLocalStorage?.(FOLD_STATE_STORAGE_KEY, state);
    } catch (error) {
      // Losing remembered fold state is harmless; never break the settings UI over it.
      console.warn('[FoldStateStore] Could not save fold state:', error);
    }
  }

  private read(): StoredFoldState {
    let raw: unknown;
    try {
      raw = this.host.loadLocalStorage?.(FOLD_STATE_STORAGE_KEY);
    } catch {
      return emptyState();
    }
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        return emptyState();
      }
    }
    if (!raw || typeof raw !== 'object') return emptyState();
    const candidate = raw as Partial<StoredFoldState>;
    if (candidate.v !== 1) return emptyState();
    return { v: 1, defaults: stringList(candidate.defaults), chat: stringList(candidate.chat) };
  }
}
