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

import type { EmbeddingService } from './EmbeddingService';

/** The parts of EmbeddingManager this accessor relies on. */
interface EmbeddingManagerView {
  isEmbeddingEnabled(): boolean;
  getService(): EmbeddingService | null;
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
    const manager = (plugin as { embeddingManager?: unknown }).embeddingManager;
    if (!isEmbeddingManagerView(manager) || !manager.isEmbeddingEnabled()) {
      return null;
    }
    return manager.getService() ?? null;
  } catch {
    return null;
  }
}
