/**
 * AppManager — Manages the lifecycle of all apps.
 *
 * Install, configure credentials, enable/disable, uninstall.
 * Registered apps become agents in the agent registry, automatically
 * discoverable via getTools and executable via useTools.
 */

import { BaseAppAgent } from '../../agents/apps/BaseAppAgent';
import { AppManifest, AppConfig, AppsSettings } from '../../types/apps/AppTypes';
import { IAgent } from '../../agents/interfaces/IAgent';
import { logger } from '../../utils/logger';
import { ElevenLabsAgent } from '../../agents/apps/elevenlabs/ElevenLabsAgent';
import { ComposerAgent } from '../../agents/apps/composer/ComposerAgent';
import { WebToolsAgent } from '../../agents/apps/webTools/WebToolsAgent';
import { App } from 'obsidian';

export class AppManager {
  private apps: Map<string, BaseAppAgent> = new Map();
  private appConfigs: Record<string, AppConfig>;
  private registerCallback: (agent: IAgent) => void;
  private unregisterCallback: (agentName: string) => void;
  private app: App | null;

  constructor(
    appsSettings: AppsSettings,
    onRegister: (agent: IAgent) => void,
    onUnregister: (agentName: string) => void,
    app?: App
  ) {
    this.appConfigs = appsSettings.apps || {};
    this.registerCallback = onRegister;
    this.unregisterCallback = onUnregister;
    this.app = app || null;
  }

  /**
   * Load all installed and enabled apps.
   * Called during plugin initialization after core agents are registered.
   */
  loadInstalledApps(): void {
    for (const [appId, config] of Object.entries(this.appConfigs)) {
      if (!config.enabled) continue;

      try {
        const agent = this.createConfiguredAgent(appId, config);
        if (!agent) {
          logger.systemWarn(`App "${appId}" is installed but no factory found — skipping`);
          continue;
        }
        this.apps.set(appId, agent);
        this.registerCallback(agent);
        logger.systemLog(`App loaded: ${appId}`);
      } catch (error) {
        logger.systemError(error as Error, `App Load: ${appId}`);
      }
    }
  }

  /**
   * Install an app by ID. Creates config entry and registers the agent.
   */
  installApp(appId: string): { success: boolean; error?: string } {
    if (this.appConfigs[appId]) {
      return { success: false, error: `App "${appId}" is already installed` };
    }

    const agent = this.createConfiguredAgent(appId);
    if (!agent) {
      return { success: false, error: `Unknown app: "${appId}"` };
    }

    this.appConfigs[appId] = {
      enabled: false,
      credentials: {},
      installedAt: new Date().toISOString(),
      installedVersion: agent.manifest.version
    };

    logger.systemLog(`App installed: ${appId}`);
    return { success: true };
  }

  /**
   * Uninstall an app. Removes from registry and clears config.
   */
  uninstallApp(appId: string): { success: boolean; error?: string } {
    if (!this.appConfigs[appId]) {
      return { success: false, error: `App "${appId}" is not installed` };
    }

    const loadedAgent = this.apps.get(appId);
    if (loadedAgent) {
      loadedAgent.onunload();
      this.unregisterCallback(loadedAgent.name);
      this.apps.delete(appId);
    }
    delete this.appConfigs[appId];

    logger.systemLog(`App uninstalled: ${appId}`);
    return { success: true };
  }

  /**
   * Update credentials for an installed app.
   */
  setAppCredentials(appId: string, credentials: Record<string, string>): boolean {
    if (!this.appConfigs[appId]) return false;

    this.appConfigs[appId].credentials = { ...credentials };
    const agent = this.apps.get(appId);
    if (agent) {
      agent.setCredentials(credentials);
    }
    return true;
  }

  /**
   * Update settings for an installed app (e.g., default model).
   */
  setAppSettings(appId: string, settings: Record<string, string>): boolean {
    if (!this.appConfigs[appId]) return false;

    this.appConfigs[appId].settings = { ...settings };
    const agent = this.apps.get(appId);
    if (agent) {
      agent.setSettings(settings);
    }
    return true;
  }

  /**
   * Enable/disable an app without uninstalling.
   */
  setAppEnabled(appId: string, enabled: boolean): boolean {
    if (!this.appConfigs[appId]) return false;
    this.appConfigs[appId].enabled = enabled;

    if (enabled && !this.apps.has(appId)) {
      const agent = this.createConfiguredAgent(appId, this.appConfigs[appId]);
      if (agent) {
        this.apps.set(appId, agent);
        this.registerCallback(agent);
      }
    } else if (!enabled && this.apps.has(appId)) {
      // Unregister but keep config
      const agent = this.apps.get(appId);
      if (agent) {
        agent.onunload();
        this.unregisterCallback(agent.name);
        this.apps.delete(appId);
      }
    }

    return true;
  }

  /**
   * Get a loaded app agent by ID.
   */
  getApp(appId: string): BaseAppAgent | undefined {
    const loaded = this.apps.get(appId);
    if (loaded) {
      return loaded;
    }

    const config = this.appConfigs[appId];
    if (!config) {
      return undefined;
    }

    return this.createConfiguredAgent(appId, config);
  }

  /**
   * List all available apps (installed or not) with their status.
   */
  getAvailableApps(): Array<{
    id: string;
    manifest: AppManifest;
    installed: boolean;
    enabled: boolean;
    configured: boolean;
  }> {
    const registry = this.getBuiltInAppRegistry();
    const results: Array<{
      id: string;
      manifest: AppManifest;
      installed: boolean;
      enabled: boolean;
      configured: boolean;
    }> = [];

    for (const [appId, factory] of registry) {
      const config = this.appConfigs[appId];
      const tempAgent = this.apps.get(appId) || this.createConfiguredAgent(appId, config) || factory();

      results.push({
        id: appId,
        manifest: tempAgent.manifest,
        installed: !!config,
        enabled: config?.enabled ?? false,
        configured: tempAgent.hasRequiredCredentials(),
      });
    }

    return results;
  }

  /**
   * Get current configs for persistence.
   */
  getAppsSettings(): AppsSettings {
    return { apps: { ...this.appConfigs } };
  }

  /**
   * Registry of built-in apps.
   * Add new apps here — just add a factory function.
   *
   * Future: could also load from a remote registry or local directory.
   */
  private getBuiltInAppRegistry(): Map<string, () => BaseAppAgent> {
    const registry = new Map<string, () => BaseAppAgent>();

    // === ADD NEW APPS HERE ===
    registry.set('elevenlabs', () => new ElevenLabsAgent());
    registry.set('composer', () => new ComposerAgent());
    registry.set('web-tools', () => new WebToolsAgent());

    return registry;
  }

  private createConfiguredAgent(appId: string, config?: AppConfig): BaseAppAgent | undefined {
    const factory = this.getBuiltInAppRegistry().get(appId);
    if (!factory) {
      return undefined;
    }

    const agent = factory();
    if (config) {
      agent.setCredentials(config.credentials);
      if (config.settings) {
        agent.setSettings(config.settings);
      }
    }
    if (this.app) {
      agent.setApp(this.app);
    }
    return agent;
  }
}
