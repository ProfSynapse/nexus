/**
 * BaseAppAgent — Base class for all app agents.
 *
 * Extends BaseAgent with credential management and app lifecycle.
 * Subclasses register their tools in the constructor and optionally
 * override onCredentialsUpdated() and validateCredentials().
 */

import { BaseAgent } from '../baseAgent';
import { AppManifest, AppCredentialField, ElevenLabsModel } from '../../types/apps/AppTypes';
import { CommonResult } from '../../types';
import { Vault } from 'obsidian';

/**
 * Result type for fetchTTSModels. Defined here so subclasses and consumers
 * can reference it without importing concrete agent classes.
 */
export interface FetchTTSModelsResult {
  success: boolean;
  models?: ElevenLabsModel[];
  error?: string;
}

export abstract class BaseAppAgent extends BaseAgent {
  readonly manifest: AppManifest;
  protected credentials: Record<string, string> = {};
  protected appSettings: Record<string, string> = {};
  private _vault: Vault | null = null;

  constructor(manifest: AppManifest) {
    super(
      manifest.agentName || manifest.id,
      manifest.description,
      manifest.version
    );
    this.manifest = manifest;
  }

  /**
   * Set credentials from settings. Called by AppManager on load/configure.
   * Credentials are NOT stored by the agent — they live in plugin settings.
   * This injects them for runtime use.
   */
  setCredentials(credentials: Record<string, string>): void {
    this.credentials = { ...credentials };
    this.onCredentialsUpdated();
  }

  /**
   * Get a specific credential value.
   * Tools call this to get API keys, tokens, etc.
   */
  getCredential(key: string): string | undefined {
    return this.credentials[key];
  }

  /**
   * Set app-specific settings (e.g., default model).
   * Called by AppManager on load/configure.
   */
  setSettings(settings: Record<string, string>): void {
    this.appSettings = { ...settings };
  }

  /**
   * Get a specific app setting value.
   */
  getSetting(key: string): string | undefined {
    return this.appSettings[key];
  }

  /**
   * Get all current app settings.
   */
  getSettings(): Record<string, string> {
    return { ...this.appSettings };
  }

  /**
   * Check if all required credentials are configured.
   */
  hasRequiredCredentials(): boolean {
    return this.manifest.credentials
      .filter(c => c.required)
      .every(c => !!this.credentials[c.key]?.trim());
  }

  /**
   * Get missing required credentials (for error messages).
   */
  getMissingCredentials(): AppCredentialField[] {
    return this.manifest.credentials
      .filter(c => c.required && !this.credentials[c.key]?.trim());
  }

  /**
   * Inject the Obsidian Vault instance. Called by AppManager after construction.
   * Tools use getVault() to save generated files.
   */
  setVault(vault: Vault): void {
    this._vault = vault;
  }

  /**
   * Get the Vault instance for file operations (saving audio, etc.).
   * Returns null if vault has not been injected yet.
   */
  getVault(): Vault | null {
    return this._vault;
  }

  /**
   * Fetch available TTS models from the provider API.
   * Override in subclasses that support model selection.
   * Returns undefined by default (no model fetching support).
   */
  async fetchTTSModels(): Promise<FetchTTSModelsResult | undefined> {
    return undefined;
  }

  /**
   * Get the user's selected default TTS model ID.
   * Override in subclasses that support model selection.
   * Returns undefined by default.
   */
  getDefaultModelId(): string | undefined {
    return undefined;
  }

  /**
   * Hook called when credentials change.
   * Override to reinitialize HTTP clients, etc.
   */
  protected onCredentialsUpdated(): void {
    // Default: no-op
  }

  /**
   * Validate credentials by checking if required ones are present.
   * Override for deeper validation (e.g., test API call).
   */
  async validateCredentials(): Promise<CommonResult> {
    if (!this.hasRequiredCredentials()) {
      const missing = this.getMissingCredentials().map(c => c.label);
      return {
        success: false,
        error: `Missing required credentials: ${missing.join(', ')}`
      };
    }
    return { success: true };
  }

  /**
   * Dynamic description — appends setup notice when credentials are missing.
   */
  get description(): string {
    if (!this.hasRequiredCredentials()) {
      const missing = this.getMissingCredentials().map(c => c.label);
      return `${this._description} [SETUP REQUIRED: configure ${missing.join(', ')} in Nexus settings]`;
    }
    return this._description;
  }
}
