/**
 * AppRuntimeContext — optional runtime services for app agents.
 *
 * Located at: src/agents/apps/AppRuntimeContext.ts
 * Most app agents only need App/Vault/credentials (injected post-construction
 * by AppManager). A few — like the Skills app — also need read access to the
 * plugin's MCPSettings (for the storage root) and the storage adapter (for the
 * SQLite index). AppManager injects this via BaseAppAgent.setRuntimeContext.
 */

import type { MCPSettings } from '../../types/plugin/PluginTypes';
import type { IStorageAdapter } from '../../database/interfaces/IStorageAdapter';
import type { SessionContextManager } from '../../services/SessionContextManager';

/** Optional runtime services injected into app agents that need settings/storage. */
export interface AppRuntimeContext {
  getSettings(): MCPSettings | undefined;
  getStorageAdapter(): IStorageAdapter | undefined;
  /** Per-session active-skill tracker for usage attribution (§9). May be undefined if not ready. */
  getSessionContextManager(): SessionContextManager | undefined;
}
