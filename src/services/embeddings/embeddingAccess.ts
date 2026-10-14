/**
 * Location: src/services/embeddings/embeddingAccess.ts
 * Purpose: The one way to reach the live EmbeddingService.
 *
 * The embedding system is not a service-container entry. PluginLifecycleManager
 * attaches an EmbeddingManager to the plugin as `plugin.embeddingManager`, and
 * the manager owns the EmbeddingService it creates. Asking the service registry
 * for `'embeddingService'` therefore always returned null, which silently turned
 * off semantic conversation search, semantic `[[` note suggestions and semantic
 * note linking for tasks and projects.
 *
 * Callers must resolve on every use and never keep the result: the manager can
 * be enabled, disabled or rebuilt during a session, and each start builds a
 * fresh service instance.
 *
 * Mobile-safe: only types are imported from the embedding modules, so loading
 * this file never pulls in the embedding engine or any Node built-in.
 */

import { Platform } from 'obsidian';
import type { EmbeddingService } from './EmbeddingService';

/**
 * Whether agents can be offered semantic search right now.
 *
 * - `available`: turned on, on a platform that supports it. The engine may
 *   still be starting; callers check resolveEmbeddingService for that.
 * - `off`: turned off — in Nexus settings, or on the running manager (a
 *   runtime toggle applies to the manager before the setting is saved).
 * - `unsupported`: this device cannot run it (mobile).
 * - `error`: turned on, but the engine failed to start or its model failed to
 *   load. It stays that way until retried; see resolveSemanticSearchFailure.
 */
export type SemanticSearchState = 'available' | 'off' | 'unsupported' | 'error';

/** The parts of EmbeddingManager this accessor relies on. */
interface EmbeddingManagerView {
  isEmbeddingEnabled(): boolean;
  getService(): EmbeddingService | null;
  /** Optional so stand-ins without a runtime view still resolve from settings. */
  isTurnedOn?(): boolean;
  getStatus?(): {
    startError?: string | null;
    progress?: { phase?: string; error?: string } | null;
  };
}

function isEmbeddingManagerView(value: unknown): value is EmbeddingManagerView {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<EmbeddingManagerView>;
  return typeof candidate.isEmbeddingEnabled === 'function'
    && typeof candidate.getService === 'function';
}

/**
 * Return the plugin's live EmbeddingService, or null when semantic search is
 * unavailable: no manager (mobile, or before storage is ready), embeddings
 * turned off, or the manager not yet initialized.
 *
 * @param plugin The Nexus plugin instance (or anything carrying `embeddingManager`).
 */
export function resolveEmbeddingService(plugin: unknown): EmbeddingService | null {
  if (plugin === null || typeof plugin !== 'object') {
    return null;
  }

  try {
    const manager = getManager(plugin);
    if (!manager || !manager.isEmbeddingEnabled()) {
      return null;
    }
    return manager.getService() ?? null;
  } catch {
    return null;
  }
}

function getManager(plugin: unknown): EmbeddingManagerView | null {
  if (plugin === null || typeof plugin !== 'object') {
    return null;
  }
  const manager = (plugin as { embeddingManager?: unknown }).embeddingManager;
  return isEmbeddingManagerView(manager) ? manager : null;
}

/**
 * Why semantic search failed to start, or null when it has not failed.
 *
 * Two failures leave a turned-on manager unable to search: initialize() threw
 * (`startError`), or the indexing pass ended in phase 'error' because the
 * embedding model did not load — the service then turns itself off. A pass
 * that errored for another reason while the service still runs is not a
 * failure here: searching the vectors already stored still works.
 */
export function resolveSemanticSearchFailure(plugin: unknown): string | null {
  try {
    const manager = getManager(plugin);
    if (!manager || typeof manager.getStatus !== 'function') {
      return null;
    }
    if (typeof manager.isTurnedOn === 'function' && !manager.isTurnedOn()) {
      return null;
    }
    const status = manager.getStatus();
    if (status.startError) {
      return status.startError;
    }
    if (status.progress?.phase === 'error') {
      const service = manager.isEmbeddingEnabled() ? manager.getService() : null;
      if (!service || !service.isServiceEnabled()) {
        return status.progress.error || 'The embedding model could not be loaded';
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Derive the semantic search state from the plugin's platform, settings and
 * the embedding manager's runtime state.
 *
 * Reads `plugin.settings.settings.enableEmbeddings`, which defaults to on.
 * The setting alone is not enough: the manager can be turned off at runtime
 * while the saved setting still says on, and reading only the setting then
 * reported "still initializing" forever for something that was off. A
 * manager that is turned off reads as `off`; one that failed to start reads
 * as `error`. Anything that is not a Nexus plugin (the headless schema
 * exporter, test stubs) therefore reads as `available`, which keeps generated
 * tool descriptions stable.
 */
export function resolveSemanticSearchState(plugin: unknown): SemanticSearchState {
  if (Platform.isMobile) {
    return 'unsupported';
  }

  try {
    const settings = (plugin as { settings?: { settings?: { enableEmbeddings?: unknown } } } | null)
      ?.settings?.settings;
    if (settings?.enableEmbeddings === false) {
      return 'off';
    }
    const manager = getManager(plugin);
    if (manager && typeof manager.isTurnedOn === 'function' && !manager.isTurnedOn()) {
      return 'off';
    }
    return resolveSemanticSearchFailure(plugin) ? 'error' : 'available';
  } catch {
    return 'available';
  }
}
