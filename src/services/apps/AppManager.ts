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
import { Vault } from 'obsidian';

export class AppManager {
  private apps: Map<string, BaseAppAgent> = new Map();
  private appConfigs: Record<string, AppConfig>;
  private registerCallback: (agent: IAgent) => void;
  private unregisterCallback: (agentName: string) => void;
  private vault: Vault | null;

  constructor(
    appsSettings: AppsSettings,
    onRegister: (agent: IAgent) => void,
    onUnregister: (agentName: string) => void,
    vault?: Vault
  ) {
    this.appConfigs = appsSettings.apps || {};
    this.registerCallback = onRegister;
    this.unregisterCallback = onUnregister;
    this.vault = vault || null;
  }

  /**
   * Load all installed and enabled apps.
   * Called during plugin initialization after core agents are registered.
   */
  async loadInstalledApps(): Promise<void> {
    const registry = this.getBuiltInAppRegistry();

    for (const [appId, config] of Object.entries(this.appConfigs)) {
      if (!config.enabled) continue;

      const factory = registry.get(appId);
      if (!factory) {
        logger.systemWarn(`App "${appId}" is installed but no factory found — skipping`);
        continue;
      }

      try {
        const agent = factory();
        agent.setCredentials(config.credentials);
        if (config.settings) agent.setSettings(config.settings);
        if (this.vault) agent.setVault(this.vault);
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
    if (this.apps.has(appId)) {
      return { success: false, error: `App "${appId}" is already installed` };
    }

    const registry = this.getBuiltInAppRegistry();
    const factory = registry.get(appId);
    if (!factory) {
      return { success: false, error: `Unknown app: "${appId}"` };
    }

    const agent = factory();

    this.appConfigs[appId] = {
      enabled: true,
      credentials: {},
      installedAt: new Date().toISOString(),
      installedVersion: agent.manifest.version
    };

    if (this.vault) agent.setVault(this.vault);
    this.apps.set(appId, agent);
    this.registerCallback(agent);

    logger.systemLog(`App installed: ${appId}`);
    return { success: true };
  }

  /**
   * Uninstall an app. Removes from registry and clears config.
   */
  uninstallApp(appId: string): { success: boolean; error?: string } {
    const agent = this.apps.get(appId);
    if (!agent) {
      return { success: false, error: `App "${appId}" is not installed` };
    }

    agent.onunload();
    this.unregisterCallback(agent.name);
    this.apps.delete(appId);
    delete this.appConfigs[appId];

    logger.systemLog(`App uninstalled: ${appId}`);
    return { success: true };
  }

  /**
   * Update credentials for an installed app.
   */
  setAppCredentials(appId: string, credentials: Record<string, string>): boolean {
    const agent = this.apps.get(appId);
    if (!agent) return false;

    agent.setCredentials(credentials);

    if (this.appConfigs[appId]) {
      this.appConfigs[appId].credentials = { ...credentials };
    }
    return true;
  }

  /**
   * Update settings for an installed app (e.g., default model).
   */
  setAppSettings(appId: string, settings: Record<string, string>): boolean {
    const agent = this.apps.get(appId);
    if (!agent) return false;

    agent.setSettings(settings);

    if (this.appConfigs[appId]) {
      this.appConfigs[appId].settings = { ...settings };
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
      // Re-register
      const registry = this.getBuiltInAppRegistry();
      const factory = registry.get(appId);
      if (factory) {
        const agent = factory();
        agent.setCredentials(this.appConfigs[appId].credentials);
        if (this.appConfigs[appId].settings) agent.setSettings(this.appConfigs[appId].settings!);
        if (this.vault) agent.setVault(this.vault);
        this.apps.set(appId, agent);
        this.registerCallback(agent);
      }
    } else if (!enabled && this.apps.has(appId)) {
      // Unregister but keep config
      const agent = this.apps.get(appId)!;
      agent.onunload();
      this.unregisterCallback(agent.name);
      this.apps.delete(appId);
    }

    return true;
  }

  /**
   * Get a loaded app agent by ID.
   */
  getApp(appId: string): BaseAppAgent | undefined {
    return this.apps.get(appId);
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
      const agent = this.apps.get(appId);
      const config = this.appConfigs[appId];
      const tempAgent = agent || factory();

      results.push({
        id: appId,
        manifest: tempAgent.manifest,
        installed: !!config,
        enabled: config?.enabled ?? false,
        configured: agent ? agent.hasRequiredCredentials() : false,
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

    return registry;
  }
}
