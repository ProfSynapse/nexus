/**
 * AppsTab — App management settings tab.
 * Follows the ProvidersTab pattern: card grid with toggle/edit, grouped sections.
 */

import { App, Notice } from 'obsidian';
import { SettingsRouter } from '../SettingsRouter';
import { Settings } from '../../settings';
import { CardItem } from '../../components/CardManager';
import { SearchableCardManager, CardGroup } from '../../components/SearchableCardManager';
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

    const appManager = this.services.appManager;
    if (!appManager) {
      this.container.createEl('p', {
        cls: 'setting-item-description',
        text: 'App manager not available. Please restart the plugin.'
      });
      return;
    }

    const apps = appManager.getAvailableApps();

    if (apps.length === 0) {
      this.container.createEl('p', {
        cls: 'setting-item-description',
        text: 'No apps available yet. Apps will appear here as they are added.'
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
      description: a.manifest.description,
      isEnabled: a.enabled,
      showToggle: true,
      showEdit: true,
      appId: a.id,
      installed: true
    }));

    const availableItems: AppCardItem[] = available.map(a => ({
      id: a.id,
      name: a.manifest.name,
      description: a.manifest.description,
      isEnabled: false,
      showToggle: false,
      showEdit: false,
      appId: a.id,
      installed: false,
      additionalActions: [{
        icon: 'download',
        label: 'Install',
        onClick: () => {
          const result = appManager.installApp(a.id);
          if (result.success) {
            new Notice(`${a.manifest.name} installed`);
            void this.saveSettings().catch(error => {
              console.error('[AppsTab] Failed to save settings after install:', error);
            });
            this.render();
          } else {
            new Notice(`Install failed: ${result.error}`);
          }
        }
      }]
    }));

    const groups: CardGroup<AppCardItem>[] = [];
    if (installedItems.length > 0) {
      groups.push({ title: 'INSTALLED APPS', items: installedItems });
    }
    if (availableItems.length > 0) {
      groups.push({ title: 'AVAILABLE APPS', items: availableItems });
    }

    new SearchableCardManager<AppCardItem>({
      containerEl: this.container,
      cardManagerConfig: {
        title: 'Apps',
        emptyStateText: 'No apps available.',
        showToggle: true,
        onToggle: async (item, enabled) => {
          if (!item.installed) return;
          appManager.setAppEnabled(item.appId, enabled);
          await this.saveSettings();
          this.render();
        },
        onEdit: (item) => {
          if (!item.installed) return;
          this.openAppModal(item.appId);
        }
      },
      groups,
      search: {
        placeholder: 'Search apps...'
      }
    });
  }

  private openAppModal(appId: string): void {
    const appManager = this.services.appManager;
    if (!appManager) {
      return;
    }
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
        agent.setCredentials(credentials);
        appManager.setAppCredentials(appId, credentials);
        await this.saveSettings();
        this.render();
      },
      onSaveSettings: async (settings) => {
        agent.setSettings(settings);
        appManager.setAppSettings(appId, settings);
        await this.saveSettings();
      },
      onValidate: agent.supportsValidation()
        ? async () => agent.validateCredentials()
        : undefined,
      validateLabel: agent.getValidationActionLabel(),
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
