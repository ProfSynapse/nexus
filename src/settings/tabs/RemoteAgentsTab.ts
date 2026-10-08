import { App, Notice } from 'obsidian';
import type { ServiceManager } from '../../core/ServiceManager';
import { CardManager, CardItem } from '../../components/CardManager';
import { Settings } from '../../settings';
import { generateUUID } from '../../utils/uuid';
import { normalizeRemoteAgentBaseUrl } from '../../services/remoteAgents/HermesConnector';
import type { RemoteAgentConnection } from '../../services/remoteAgents/types';
import type { RemoteAgentConnectionRegistry } from '../../services/remoteAgents/RemoteAgentConnectionRegistry';
import { RemoteAgentModal, connectionAvailabilityLabel } from '../remoteAgents/RemoteAgentModal';

interface RemoteAgentCard extends CardItem {
  connection: RemoteAgentConnection;
}

export interface RemoteAgentsTabServices {
  app: App;
  settings: Settings;
  serviceManager?: ServiceManager;
}

/** Remote execution connections are kept separate from inference providers. */
export class RemoteAgentsTab {
  private destroyed = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly checking = new Set<string>();

  constructor(private readonly container: HTMLElement, private readonly services: RemoteAgentsTabServices) {
    this.render();
  }

  private render(): void {
    if (this.destroyed) return;
    this.container.empty();
    this.container.createEl('h2', { text: 'Remote agents' });
    this.container.createEl('p', {
      cls: 'setting-item-description',
      text: 'Connect an agent running on your server so Nexus can delegate tasks to it.',
    });
    const cards = this.container.createDiv('nexus-remote-agent-cards');
    const items = (this.services.settings.settings.remoteAgents ?? []).map(connection => ({
      id: connection.id,
      name: connection.displayName,
      description: connection.description || 'General-purpose assistant',
      isEnabled: connection.enabled,
      connection,
    }));
    const manager = new CardManager<RemoteAgentCard>({
      containerEl: cards,
      title: 'Remote agents',
      emptyStateText: 'No remote agents yet. Add a Hermes connection to get started.',
      addButtonText: 'Add remote agent',
      showAddButton: true,
      showToggle: true,
      items,
      onAdd: () => this.edit({
        id: `remote-agent-${generateUUID()}`,
        connector: 'hermes', displayName: '', baseUrl: '', apiKey: '', enabled: true,
      }),
      onEdit: item => {
        void this.saveQueue.catch(() => undefined).then(() => {
          if (this.destroyed) return;
          const latest = this.services.settings.settings.remoteAgents?.find(connection => connection.id === item.id);
          if (latest) this.edit(latest);
        });
      },
      onToggle: async (item, enabled) => {
        try {
          await this.save({ ...item.connection, enabled });
        } catch {
          new Notice('Failed to save remote agent settings. Please try again.');
          this.render();
        }
      },
    });
    const registry = this.services.serviceManager?.getServiceIfReady<RemoteAgentConnectionRegistry>('remoteAgentRegistry');
    for (const item of items) {
      const card = manager.getCard(item.id)?.getElement();
      card?.createDiv({
        cls: 'setting-item-description nexus-remote-agent-address',
        text: `Hermes · ${item.connection.baseUrl}`,
      });
      const label = connectionAvailabilityLabel(item.connection.enabled, registry?.getHealth(item.id), this.checking.has(item.id));
      card?.createDiv({
        cls: `nexus-remote-agent-status${label === 'Available' ? ' is-available' : label.includes('unavailable') ? ' is-unavailable' : ''}`,
        text: label,
        attr: { role: 'status' },
      });
    }
  }

  private edit(connection: RemoteAgentConnection): void {
    new RemoteAgentModal(this.services.app, connection, {
      normalizeUrl: normalizeRemoteAgentBaseUrl,
      save: config => this.save(config),
      check: async config => {
        this.checking.add(config.id);
        this.render();
        try {
          const registry = await this.services.serviceManager?.getService<RemoteAgentConnectionRegistry>('remoteAgentRegistry');
          if (!registry) throw new Error('Remote agent connections are still starting. Please try again.');
          await registry.refresh(config.id);
          const result = registry.getHealth(config.id);
          if (!result) throw new Error('Connection settings changed. Test the connection again.');
          return result;
        } finally {
          this.checking.delete(config.id);
          this.render();
        }
      },
    }).open();
  }

  private save(connection: RemoteAgentConnection): Promise<void> {
    const snapshot = { ...connection, apiKey: connection.apiKey ?? '' };
    const pending = this.saveQueue.catch(() => undefined).then(async () => {
      const previous = this.services.settings.settings.remoteAgents ?? [];
      const exists = previous.some(item => item.id === snapshot.id);
      this.services.settings.settings.remoteAgents = exists
        ? previous.map(item => item.id === snapshot.id ? snapshot : item)
        : [...previous, snapshot];
      try {
        await this.services.settings.saveSettings();
      } catch (error) {
        this.services.settings.settings.remoteAgents = previous;
        throw error;
      }
      this.render();
    });
    this.saveQueue = pending;
    return pending;
  }

  destroy(): void {
    this.destroyed = true;
  }
}
