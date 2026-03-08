/**
 * AppsTab — App management settings tab.
 * Follows the ProvidersTab pattern: card grid with toggle/edit, grouped sections.
 */

import { App, Notice } from 'obsidian';
import { SettingsRouter } from '../SettingsRouter';
import { Settings } from '../../settings';
import { Card, CardConfig } from '../../components/Card';
import { AppConfigModal, AppSettingsSection } from '../../components/AppConfigModal';
import { AppManager } from '../../services/apps/AppManager';
import { ElevenLabsAgent } from '../../agents/apps/elevenlabs/ElevenLabsAgent';

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

    // Installed Apps section
    if (installed.length > 0) {
      this.container.createDiv('nexus-provider-group-title').setText('INSTALLED APPS');
      const grid = this.container.createDiv('card-manager-grid');
      for (const app of installed) {
        this.renderInstalledCard(grid, app);
      }
    }

    // Available Apps section
    if (available.length > 0) {
      this.container.createDiv('nexus-provider-group-title').setText('AVAILABLE APPS');
      const grid = this.container.createDiv('card-manager-grid');
      for (const app of available) {
        this.renderAvailableCard(grid, app);
      }
    }
  }

  private renderInstalledCard(
    grid: HTMLElement,
    app: { id: string; manifest: import('../../types/apps/AppTypes').AppManifest; installed: boolean; enabled: boolean; configured: boolean }
  ): void {
    const description = app.configured ? 'Configured' : 'Setup required';
    const cardConfig: CardConfig = {
      title: app.manifest.name,
      description,
      isEnabled: app.enabled,
      showToggle: true,
      onToggle: async (enabled: boolean) => {
        this.services.appManager!.setAppEnabled(app.id, enabled);
        await this.saveSettings();
        this.render();
      },
      onEdit: () => {
        this.openAppModal(app.id);
      }
    };
    new Card(grid, cardConfig);
  }

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
   */
  private buildSettingsSections(
    _appId: string,
    agent: import('../../agents/apps/BaseAppAgent').BaseAppAgent
  ): AppSettingsSection[] {
    if (agent instanceof ElevenLabsAgent) {
      return [{
        key: 'defaultTTSModel',
        label: 'Default TTS model',
        description: 'Model used for text-to-speech when no model is specified.',
        loadOptions: async () => {
          const result = await agent.fetchTTSModels();
          if (!result.success || !result.models) {
            return { success: false, error: result.error };
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
