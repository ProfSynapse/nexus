/**
 * AppsTab — App management settings tab.
 * Follows the ProvidersTab pattern: card grid with toggle/edit, grouped sections.
 */

import { App, Notice } from 'obsidian';
import { SettingsRouter } from '../SettingsRouter';
import { Settings } from '../../settings';
import { Card, CardConfig } from '../../components/Card';
import { CardItem } from '../../components/CardManager';
import { SearchableCardManager } from '../../components/SearchableCardManager';
import { AppConfigModal, AppSettingsSection } from '../../components/AppConfigModal';
import { AppManager } from '../../services/apps/AppManager';

/**
 * CardItem-compatible representation of an app for SearchableCardManager
 */
interface AppCardItem extends CardItem {
  appId: string;
  installed: boolean;
}

export interface AppsTabServices {
  app: App;
  settings: Settings;
  appManager?: AppManager;
}

export class AppsTab {
  private container: HTMLElement;
  private router: SettingsRouter;
  private services: AppsTabServices;

  constructor(
    container: HTMLElement,
    router: SettingsRouter,
    services: AppsTabServices
  ) {
    this.container = container;
    this.router = router;
    this.services = services;
    this.render();
  }

  render(): void {
    this.container.empty();

    if (!this.services.appManager) {
      this.container.createEl('p', {
        cls: 'setting-item-description',
        text: 'App manager not available. Please restart the plugin.'
      });
      return;
    }

    const apps = this.services.appManager.getAvailableApps();

    if (apps.length === 0) {
      this.container.createEl('p', {
        cls: 'setting-item-description',
        text: 'No apps available yet. Apps will appear here as they are added to Nexus.'
      });
      return;
    }

    // Split into installed and available
    const installed = apps.filter(a => a.installed);
    const available = apps.filter(a => !a.installed);

    // Build card items for each section
    const installedItems: AppCardItem[] = installed.map(a => ({
      id: a.id,
      name: a.manifest.name,
      description: a.configured ? 'Configured' : 'Setup required',
      isEnabled: a.enabled,
      appId: a.id,
      installed: true
    }));

    // Render Installed Apps with toggle + edit
    if (installedItems.length > 0) {
      this.container.createDiv('nexus-provider-group-title').setText('INSTALLED APPS');
      new SearchableCardManager<AppCardItem>({
        containerEl: this.container,
        cardManagerConfig: {
          title: 'Installed Apps',
          addButtonText: '',
          emptyStateText: 'No installed apps.',
          showAddButton: false,
          showToggle: true,
          onAdd: () => {},
          onToggle: async (item, enabled) => {
            this.services.appManager!.setAppEnabled(item.appId, enabled);
            await this.saveSettings();
            this.render();
          },
          onEdit: (item) => {
            this.openAppModal(item.appId);
          }
        },
        items: installedItems,
        search: {
          placeholder: 'Search installed apps...'
        }
      });
    }

    // Render Available Apps with install action (direct Card — needs additionalActions)
    if (available.length > 0) {
      this.container.createDiv('nexus-provider-group-title').setText('AVAILABLE APPS');
      const grid = this.container.createDiv('card-manager-grid');
      for (const app of available) {
        this.renderAvailableCard(grid, app);
      }
    }
  }

  /**
   * Render an available (not installed) app card with install action
   */
  private renderAvailableCard(
    grid: HTMLElement,
    app: { id: string; manifest: import('../../types/apps/AppTypes').AppManifest }
  ): void {
    const cardConfig: CardConfig = {
      title: app.manifest.name,
      description: app.manifest.description,
      showToggle: false,
      additionalActions: [{
        icon: 'download',
        label: 'Install',
        onClick: () => {
          const result = this.services.appManager!.installApp(app.id);
          if (result.success) {
            new Notice(`${app.manifest.name} installed`);
            this.saveSettings();
            this.render();
          } else {
            new Notice(`Install failed: ${result.error}`);
          }
        }
      }]
    };
    new Card(grid, cardConfig);
  }

  private openAppModal(appId: string): void {
    const appManager = this.services.appManager!;
    const agent = appManager.getApp(appId);
    if (!agent) return;

    const config = appManager.getAppsSettings().apps[appId];
    if (!config) return;

    // Build settings sections for agents that support them
    const settingsSections = this.buildSettingsSections(appId, agent);
    new AppConfigModal(this.services.app, {
      manifest: agent.manifest,
      credentials: { ...config.credentials },
      settings: { ...(config.settings || {}) },
      onSave: async (credentials) => {
        appManager.setAppCredentials(appId, credentials);
        await this.saveSettings();
        this.render();
      },
      onSaveSettings: async (settings) => {
        appManager.setAppSettings(appId, settings);
        await this.saveSettings();
      },
      onValidate: async () => {
        return agent.validateCredentials();
      },
      onUninstall: async () => {
        appManager.uninstallApp(appId);
        await this.saveSettings();
        this.render();
        new Notice(`${agent.manifest.name} uninstalled`);
      },
      settingsSections,
    }).open();
  }

  /**
   * Build settings sections for an app agent.
   * Returns app-specific dropdowns (e.g., ElevenLabs model selection).
   * Uses manifest.id to identify apps (avoids instanceof issues with bundlers).
   */
  private buildSettingsSections(
    _appId: string,
    agent: import('../../agents/apps/BaseAppAgent').BaseAppAgent
  ): AppSettingsSection[] {
    if (agent.manifest.id === 'elevenlabs') {
      return [{
        key: 'defaultTTSModel',
        label: 'Default TTS model',
        description: 'Model used for text-to-speech when no model is specified.',
        loadOptions: async () => {
          const result = await agent.fetchTTSModels();
          if (!result || !result.success || !result.models) {
            return { success: false, error: result?.error || 'Model fetching not supported' };
          }
          return {
            success: true,
            options: result.models.map(m => ({
              value: m.model_id,
              label: m.name,
            })),
          };
        },
      }];
    }
    return [];
  }

  private async saveSettings(): Promise<void> {
    if (this.services.settings && this.services.appManager) {
      this.services.settings.settings.apps = this.services.appManager.getAppsSettings();
      await this.services.settings.saveSettings();
    }
  }

  destroy(): void {
    // No resources to clean up
  }
}
