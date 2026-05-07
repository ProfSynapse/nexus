/**
 * Maintenance Command Manager
 * Handles maintenance and troubleshooting commands
 */

import { Modal, Notice, Platform, type App, type Plugin } from 'obsidian';
import { CommandContext } from './CommandDefinitions';
import type NexusPlugin from '../../main';
type SyncableStorageAdapter = {
  sync(): Promise<unknown>;
};

type RebuildableStorageAdapter = {
  rebuildCache(options?: { onProgress?: (label: string, done: number, total: number) => void }): Promise<void>;
};

function isSyncableStorageAdapter(value: unknown): value is SyncableStorageAdapter {
  return typeof value === 'object' && value !== null && 'sync' in value && typeof value.sync === 'function';
}

function isRebuildableStorageAdapter(value: unknown): value is RebuildableStorageAdapter {
  return typeof value === 'object' && value !== null && 'rebuildCache' in value && typeof (value as RebuildableStorageAdapter).rebuildCache === 'function';
}

class RebuildCacheConfirmModal extends Modal {
  private confirmed = false;

  constructor(app: App, private onConfirm: () => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('Rebuild Nexus cache?');

    const body = this.contentEl.createDiv();
    body.createEl('p', {
      text: 'This wipes the local cache and rebuilds it from the synced event store. Your conversations, workspaces, and tasks are not deleted — they live in the synced files which are not touched.'
    });
    body.createEl('p', {
      text: 'The plugin will be unresponsive while the rebuild runs. This usually takes a few seconds.'
    });

    const buttonRow = this.contentEl.createDiv({ cls: 'modal-button-container' });
    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());

    const confirmBtn = buttonRow.createEl('button', { text: 'Rebuild cache', cls: 'mod-warning' });
    confirmBtn.addEventListener('click', () => {
      this.confirmed = true;
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.confirmed) {
      this.onConfirm();
    }
  }
}

type MaintenancePlugin = Plugin & {
  app: App & {
    setting: {
      open(): void;
      openTabById(id: string): void;
    };
  };
  addCommand: Plugin['addCommand'];
};

export class MaintenanceCommandManager {
  constructor(private context: CommandContext) {}

  /**
   * Execute maintenance command
   */
  async executeMaintenanceCommand(_commandId: string): Promise<void> {
    // Basic maintenance operations
  }

  /**
   * Get available maintenance commands
   */
  getMaintenanceCommands(): string[] {
    return ['open-settings', 'run-diagnostics'];
  }

  /**
   * Register maintenance commands
   */
  registerMaintenanceCommands(): void {
    this.registerDiagnosticsCommand();
    this.registerRefreshSyncedDataCommand();
    this.registerRebuildCacheCommand();
    this.registerClaudeHeadlessExperimentCommand();
  }

  /**
   * Register troubleshoot command
   */
  registerTroubleshootCommand(): void {
    return;
  }

  /**
   * Register diagnostics command for testing service health
   */
  private registerDiagnosticsCommand(): void {
    (this.context.plugin as unknown as MaintenancePlugin).addCommand({
      id: 'run-service-diagnostics',
      name: 'Run service diagnostics',
      callback: async () => {
        await this.runServiceDiagnostics();
      }
    });
  }

  /**
   * Register a command that refreshes synced Nexus JSONL data into the local cache.
   * Useful on mobile when the vault finishes syncing after the plugin has already initialized.
   */
  private registerRefreshSyncedDataCommand(): void {
    (this.context.plugin as unknown as MaintenancePlugin).addCommand({
      id: 'refresh-synced-data',
      name: 'Refresh synced data',
      callback: async () => {
        new Notice('Refreshing synced Nexus data...');

        try {
          if (!this.context.getService) {
            throw new Error('Service lookup unavailable');
          }

          const service = await this.context.getService('hybridStorageAdapter', 10000);
          if (!isSyncableStorageAdapter(service)) {
            throw new Error('Hybrid storage adapter is not available');
          }

          await service.sync();
          new Notice('Reconciliation complete.');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[MaintenanceCommandManager] Failed to refresh synced Nexus data:', error);
          new Notice(`Failed to refresh Nexus data: ${message}`);
        }
      }
    });
  }

  /**
   * Register a command that wipes the local SQLite cache and rebuilds it from
   * the JSONL event store. Use this when the cache backend is corrupted or
   * out-of-sync with the JSONL source of truth (e.g. after manual file edits).
   */
  private registerRebuildCacheCommand(): void {
    (this.context.plugin as unknown as MaintenancePlugin).addCommand({
      id: 'rebuild-cache',
      name: 'Rebuild cache',
      callback: () => {
        const plugin = this.context.plugin as unknown as MaintenancePlugin;
        const modal = new RebuildCacheConfirmModal(plugin.app, () => {
          void this.runRebuildCache();
        });
        modal.open();
      }
    });
  }

  private async runRebuildCache(): Promise<void> {
    const stickyNotice = new Notice('Rebuilding Nexus cache...', 0);

    try {
      if (!this.context.getService) {
        throw new Error('Service lookup unavailable');
      }

      const service = await this.context.getService('hybridStorageAdapter', 10000);
      if (!isRebuildableStorageAdapter(service)) {
        throw new Error('Hybrid storage adapter is not available');
      }

      await service.rebuildCache();
      stickyNotice.hide();
      new Notice('Nexus cache rebuilt successfully.');
    } catch (error) {
      stickyNotice.hide();
      const message = error instanceof Error ? error.message : String(error);
      console.error('[MaintenanceCommandManager] Failed to rebuild Nexus cache:', error);
      new Notice(`Failed to rebuild Nexus cache: ${message}`);
    }
  }

  /**
   * Register an experimental command that launches the user's local Claude CLI
   * in print mode against this vault's Nexus MCP connector.
   */
  private registerClaudeHeadlessExperimentCommand(): void {
    (this.context.plugin as unknown as MaintenancePlugin).addCommand({
      id: 'experimental-run-claude-headless-session',
      name: 'Launch a headless session',
      callback: async () => {
        if (!Platform.isDesktop) {
          new Notice('This experiment is only available on desktop.');
          return;
        }

        const { ClaudeHeadlessModal } = await import('../../ui/experimental/ClaudeHeadlessModal');
        const plugin = this.context.plugin as unknown as MaintenancePlugin & NexusPlugin;
        new ClaudeHeadlessModal(plugin.app, plugin).open();
      }
    });
  }

  /**
   * Run comprehensive service diagnostics
   */
  private async runServiceDiagnostics(): Promise<void> {
    new Notice('Running service diagnostics... Check console for results.');

    let passed = 0;
    let failed = 0;
    const results: string[] = [];

    // Check critical services
    const criticalServices = [
      'vaultOperations',
      'workspaceService',
      'memoryService',
      'sessionService',
      'llmService',
      'customPromptStorageService',
      'conversationService',
      'chatService'
    ];

    for (const serviceName of criticalServices) {
      try {
        if (!this.context.getService) {
          console.error(`❌ ${serviceName}: getService not available`);
          results.push(`❌ ${serviceName}: getService not available`);
          failed++;
          continue;
        }

        const service = await this.context.getService(serviceName, 5000);
        if (service) {
          results.push(`✅ ${serviceName}`);
          passed++;
        } else {
          console.error(`❌ ${serviceName}: Not initialized`);
          results.push(`❌ ${serviceName}: Not initialized`);
          failed++;
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`❌ ${serviceName}: Error -`, message);
        results.push(`❌ ${serviceName}: ${message}`);
        failed++;
      }
    }

    // Check plugin.services getter
    const services = (this.context.plugin as unknown as NexusPlugin).services;
    const expectedServices = ['memoryService', 'workspaceService', 'sessionService', 'conversationService', 'customPromptStorageService'];

    for (const name of expectedServices) {
      if (services && services[name]) {
        results.push(`✅ plugin.services.${name}`);
        passed++;
      } else {
        console.error(`❌ plugin.services.${name}: Missing`);
        results.push(`❌ plugin.services.${name}: Missing`);
        failed++;
      }
    }

    // Final report
    if (failed === 0) {
      new Notice(`✅ All services healthy! (${passed} passed)`);
    } else {
      new Notice(`⚠️ ${failed} service(s) failed. Check console for details.`);
    }
  }
}
