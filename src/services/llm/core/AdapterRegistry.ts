/**
 * AdapterRegistry - compatibility facade over provider drivers and instances.
 *
 * Existing provider IDs remain the implicit default instance IDs in v1. This
 * keeps saved conversations, defaults, aliases, and settings stable while the
 * registry gains an explicit lifecycle boundary for future multi-instance use.
 */

import type { Vault } from 'obsidian';
import type { LLMProviderSettings } from '../../../types';
import { isMobile } from '../../../utils/platform';
import type { BaseAdapter } from '../adapters/BaseAdapter';
import type { WebLLMAdapter as WebLLMAdapterType } from '../adapters/webllm/WebLLMAdapter';
import {
  createBuiltinProviderDrivers,
  type BuiltinProviderDriverRegistration,
} from '../providers/BuiltinProviderDrivers';
import {
  defaultProviderInstanceId,
  providerDriverKind,
  providerInstanceId,
  type ProviderDriver,
  type ProviderInstance,
} from '../providers/ProviderDriver';
import { ProviderDriverRegistry } from '../providers/ProviderDriverRegistry';

/** API-key providers ↔ OAuth/CLI compatibility counterparts. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  openai: 'openai-codex',
  'openai-codex': 'openai',
  anthropic: 'anthropic-claude-code',
  'anthropic-claude-code': 'anthropic',
  google: 'google-gemini-cli',
  'google-gemini-cli': 'google',
};

export interface IAdapterRegistry {
  initialize(settings: LLMProviderSettings, vault?: Vault): void;
  updateSettings(settings: LLMProviderSettings): void;
  getAdapter(providerId: string): BaseAdapter | undefined;
  getAvailableProviders(): string[];
  isProviderAvailable(providerId: string): boolean;
  clear(): void;
}

export class AdapterRegistry implements IAdapterRegistry {
  private vault?: Vault;
  private readonly providerRegistry = new ProviderDriverRegistry();
  private readonly registrations: BuiltinProviderDriverRegistration[];
  private lifecycleTail: Promise<void> = Promise.resolve();
  private initPromise: Promise<void> = Promise.resolve();
  private onSettingsDirty?: () => void;

  constructor(_settings: LLMProviderSettings, vault?: Vault) {
    this.vault = vault;
    this.registrations = createBuiltinProviderDrivers();
    for (const registration of this.registrations) {
      this.providerRegistry.registerDriver(registration.driver);
    }
  }

  initialize(settings: LLMProviderSettings, vault?: Vault): void {
    if (vault) this.vault = vault;

    const settingsSnapshot = settings;
    const vaultSnapshot = this.vault;
    this.initPromise = this.enqueueLifecycle(async () => {
      try {
        await this.providerRegistry.clear();
      } catch (error) {
        this.logError('lifecycle', error);
      }
      await this.initializeAdaptersAsync(settingsSnapshot, vaultSnapshot);
    });
  }

  async waitForInit(): Promise<void> {
    await this.initPromise;
  }

  setOnSettingsDirty(callback: () => void): void {
    this.onSettingsDirty = callback;
  }

  updateSettings(settings: LLMProviderSettings): void {
    this.initialize(settings, this.vault);
  }

  getAdapter(providerId: string): BaseAdapter | undefined {
    const direct = this.getProviderInstance(providerId)?.adapter;
    if (direct) return direct;

    const alias = PROVIDER_ALIASES[providerId];
    const fallback = alias ? this.getProviderInstance(alias)?.adapter : undefined;
    if (fallback) {
      console.warn(`AdapterRegistry: '${providerId}' not found, falling back to '${alias}'`);
    }
    return fallback;
  }

  getAvailableProviders(): string[] {
    return this.providerRegistry.getInstances().map((instance) => instance.id);
  }

  isProviderAvailable(providerId: string): boolean {
    if (this.getProviderInstance(providerId)) return true;
    const alias = PROVIDER_ALIASES[providerId];
    return alias ? Boolean(this.getProviderInstance(alias)) : false;
  }

  /** Compatibility API: schedule lifecycle-owned cleanup without exposing a promise. */
  clear(): void {
    const cleanup = this.enqueueLifecycle(() => this.providerRegistry.clear());
    this.initPromise = cleanup.catch((error) => {
      this.logError('lifecycle', error);
    });
  }

  /** Awaitable cleanup used by the plugin service lifecycle. */
  async dispose(): Promise<void> {
    const cleanup = this.enqueueLifecycle(() => this.providerRegistry.clear());
    this.initPromise = cleanup;
    await cleanup;
  }

  getProviderInstance(instanceId: string): ProviderInstance | undefined {
    const normalized = this.tryProviderInstanceId(instanceId);
    return normalized ? this.providerRegistry.getInstance(normalized) : undefined;
  }

  getProviderDriver(driverKind: string): ProviderDriver<unknown> | undefined {
    const normalized = this.tryProviderDriverKind(driverKind);
    return normalized ? this.providerRegistry.getDriver(normalized) : undefined;
  }

  getWebLLMAdapter(): WebLLMAdapterType | undefined {
    return this.getProviderInstance('webllm')?.adapter as WebLLMAdapterType | undefined;
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const next = this.lifecycleTail
      .catch((error) => {
        this.logError('lifecycle', error);
      })
      .then(operation);
    this.lifecycleTail = next;
    return next;
  }

  private async initializeAdaptersAsync(
    settings: LLMProviderSettings,
    vault?: Vault
  ): Promise<void> {
    const providers = settings?.providers;
    if (!providers) return;

    const onMobile = isMobile();
    for (const registration of this.registrations) {
      const { driver } = registration;
      if (onMobile && driver.compatibility === 'desktop-only') continue;

      const config = providers[driver.kind];
      if (!registration.shouldInitialize(config, vault)) continue;

      try {
        await this.providerRegistry.createInstance({
          driverKind: driver.kind,
          instanceId: defaultProviderInstanceId(driver.kind),
          displayName: driver.displayName,
          config,
          vault,
          onSettingsDirty: () => this.onSettingsDirty?.(),
        });
      } catch (error) {
        console.error(`AdapterRegistry: Failed to initialize ${driver.kind} adapter:`, error);
        this.logError(driver.kind, error);
      }
    }
  }

  private tryProviderDriverKind(value: string) {
    try {
      return providerDriverKind(value);
    } catch {
      return undefined;
    }
  }

  private tryProviderInstanceId(value: string) {
    try {
      return providerInstanceId(value);
    } catch {
      return undefined;
    }
  }

  private logError(providerId: string, error: unknown): void {
    console.error(`AdapterRegistry: Error details for ${providerId}:`, {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      name: error instanceof Error ? error.name : undefined,
    });
  }
}
