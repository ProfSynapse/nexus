/**
 * Service Accessors for Memory Search
 *
 * Location: src/agents/searchManager/services/ServiceAccessors.ts
 * Purpose: Runtime service lookup utilities for the search subsystem.
 *          Extracts repetitive service resolution patterns from MemorySearchProcessor.
 * Used by: MemorySearchProcessor delegates service resolution here.
 */

import { App, Plugin } from 'obsidian';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import type NexusPlugin from '../../../main';
import type { MemoryService } from '../../memoryManager/services/MemoryService';
import type { WorkspaceService } from '../../../services/WorkspaceService';
import type { EmbeddingService } from '../../../services/embeddings/EmbeddingService';
import type { IMessageRepository } from '../../../database/repositories/interfaces/IMessageRepository';
import type { IStorageAdapter } from '../../../database/interfaces/IStorageAdapter';

/**
 * Provides runtime service resolution for the search subsystem.
 *
 * Services are resolved lazily via the plugin's `getServiceIfReady` API,
 * returning `undefined` when a service has not yet initialised or is
 * unavailable (e.g. embeddings on mobile).
 */
export class ServiceAccessors {
  private plugin: Plugin;
  private storageAdapter?: IStorageAdapter;

  constructor(plugin: Plugin, storageAdapter?: IStorageAdapter) {
    this.plugin = plugin;
    this.storageAdapter = storageAdapter;
  }

  /**
   * Resolve the MemoryService from the running plugin instance.
   */
  getMemoryService(): MemoryService | undefined {
    try {
      const app: App = this.plugin.app;
      const plugin = getNexusPlugin(app) as NexusPlugin | null;
      if (plugin) {
        return plugin.getServiceIfReady<MemoryService>('memoryService') || undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve the WorkspaceService from the running plugin instance.
   */
  getWorkspaceService(): WorkspaceService | undefined {
    try {
      const app: App = this.plugin.app;
      const plugin = getNexusPlugin(app) as NexusPlugin | null;
      if (plugin) {
        return plugin.getServiceIfReady<WorkspaceService>('workspaceService') || undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve the EmbeddingService from the running plugin instance.
   */
  getEmbeddingService(): EmbeddingService | undefined {
    try {
      const app: App = this.plugin.app;
      const plugin = getNexusPlugin(app) as NexusPlugin | null;
      if (plugin) {
        return plugin.getServiceIfReady<EmbeddingService>('embeddingService') || undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Get the MessageRepository from the storage adapter.
   * Uses the optional `messages` getter defined on IStorageAdapter.
   */
  getMessageRepository(): IMessageRepository | undefined {
    return this.storageAdapter?.messages;
  }
}
