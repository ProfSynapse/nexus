/**
 * WebLLMLifecycleManager
 *
 * Manages the lifecycle of WebLLM/Nexus model loading and unloading.
 * Implements smart loading/unloading based on:
 * - Provider selection (load when switching to webllm, unload when switching away)
 * - Idle timeout (unload after 10 minutes of inactivity)
 * - ChatView state (pre-load if Nexus is default when ChatView opens)
 *
 * This service reduces GPU memory usage by automatically unloading the model
 * when not in use, while ensuring responsive loading when needed.
 */

import { WebLLMAdapter } from './WebLLMAdapter';
import { WEBLLM_MODELS } from './WebLLMModels';
import { Notice } from 'obsidian';
import { getAllPluginIds } from '../../../../constants/branding';

export interface WebLLMLifecycleCallbacks {
  onLoadingStart?: () => void;
  onLoadingProgress?: (progress: number, stage: string) => void;
  onLoadingComplete?: () => void;
  onUnload?: () => void;
  onError?: (error: Error) => void;
}

/**
 * Helper function to safely get instanceId from adapter
 * Uses 'in' operator type guard and Record<string, unknown> for type safety
 * instead of 'as any' cast
 */
function getAdapterInstanceId(adapter: WebLLMAdapter | null): number | undefined {
  if (adapter && 'instanceId' in adapter) {
    const value = (adapter as unknown as Record<string, unknown>).instanceId;
    return typeof value === 'number' ? value : undefined;
  }
  return undefined;
}

/**
 * Helper function to safely get plugin registry from window
 * Uses Record<string, unknown> for type-safe nested property access
 * instead of 'as any' cast
 */
function getPluginRegistry(): Record<string, unknown> | undefined {
  const globalWindow = window as unknown as Record<string, unknown>;
  if (!globalWindow.app || typeof globalWindow.app !== 'object') {
    return undefined;
  }

  const app = globalWindow.app as Record<string, unknown>;
  if (!app.plugins || typeof app.plugins !== 'object') {
    return undefined;
  }

  const plugins = app.plugins as Record<string, unknown>;
  if (!plugins.plugins || typeof plugins.plugins !== 'object') {
    return undefined;
  }

  return plugins.plugins as Record<string, unknown>;
}

export class WebLLMLifecycleManager {
  private static readonly IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

  private adapter: WebLLMAdapter | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivityTime: number = 0;
  private callbacks: WebLLMLifecycleCallbacks = {};
  private isLoading: boolean = false;
  private isChatViewOpen: boolean = false;

  /**
   * Set the WebLLM adapter reference
   * Called when AdapterRegistry initializes
   */
  setAdapter(adapter: WebLLMAdapter | null): void {
    this.adapter = adapter;
  }

  /**
   * Set callbacks for lifecycle events
   */
  setCallbacks(callbacks: WebLLMLifecycleCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Check if Nexus is the default provider
   */
  private isNexusDefaultProvider(): boolean {
    try {
      const registry = getPluginRegistry();
      if (!registry) {
        return false;
      }

      for (const id of getAllPluginIds()) {
        const plugin = registry[id];
        if (!plugin || typeof plugin !== 'object') {
          continue;
        }

        // Navigate through nested structure safely
        const pluginObj = plugin as Record<string, unknown>;
        const settings = pluginObj.settings;
        if (!settings || typeof settings !== 'object') {
          continue;
        }

        const settingsObj = settings as Record<string, unknown>;
        const settingsData = settingsObj.settings;
        if (!settingsData || typeof settingsData !== 'object') {
          continue;
        }

        const settingsDataObj = settingsData as Record<string, unknown>;
        const llmProviders = settingsDataObj.llmProviders;
        if (!llmProviders || typeof llmProviders !== 'object') {
          continue;
        }

        const llmProvidersObj = llmProviders as Record<string, unknown>;
        const defaultModel = llmProvidersObj.defaultModel;
        if (!defaultModel || typeof defaultModel !== 'object') {
          continue;
        }

        const defaultModelObj = defaultModel as Record<string, unknown>;
        const provider = defaultModelObj.provider;

        if (provider === 'webllm') {
          return true;
        }
      }

      return false;
    } catch (error) {
      return false;
    }
  }

  /**
   * Check if the model is installed
   */
  private async isModelInstalled(): Promise<boolean> {
    if (!this.adapter) return false;

    try {
      const modelSpec = WEBLLM_MODELS[0];
      if (!modelSpec) return false;

      const modelManager = this.adapter.getModelManager();
      return await modelManager.isModelInstalled(modelSpec.id);
    } catch {
      return false;
    }
  }

  /**
   * Handle ChatView opened event
   * Pre-load model if Nexus is default provider
   * Note: WebLLM uses browser Cache API, so we don't check isModelInstalled()
   * (that checks vault storage which is a separate system)
   */
  async handleChatViewOpened(): Promise<void> {
    this.isChatViewOpen = true;

    if (!this.adapter) {
      return;
    }

    const isNexusDefault = this.isNexusDefaultProvider();
    const isLoaded = this.adapter.isModelLoaded();

    // Auto-load if Nexus is default - WebLLM will use browser cache if available
    if (isNexusDefault && !isLoaded && !this.isLoading) {
      await this.loadModel();
    }
  }

  /**
   * Handle ChatView closed event
   * Start idle timer (don't immediately unload)
   */
  handleChatViewClosed(): void {
    this.isChatViewOpen = false;
    // Don't immediately unload - let idle timer handle it
    this.startIdleTimer();
  }

  /**
   * Handle provider change event
   * Load model when switching TO webllm, unload when switching AWAY
   */
  async handleProviderChanged(fromProvider: string, toProvider: string): Promise<void> {
    if (!this.adapter) return;

    if (toProvider === 'webllm') {
      // Switching TO Nexus
      const isInstalled = await this.isModelInstalled();
      const isLoaded = this.adapter.isModelLoaded();

      if (isInstalled && !isLoaded && !this.isLoading) {
        await this.loadModel();
      }

      // Clear idle timer when actively using Nexus
      this.clearIdleTimer();

    } else if (fromProvider === 'webllm') {
      // Switching AWAY from Nexus
      if (this.adapter.isModelLoaded()) {
        await this.unloadModel();
      }
    }
  }

  /**
   * Record activity (generation start/complete)
   * Resets the idle timer
   */
  recordActivity(): void {
    this.lastActivityTime = Date.now();
    this.clearIdleTimer();
    this.startIdleTimer();
  }

  /**
   * Load the model into GPU memory
   * Note: WebLLM uses browser Cache API for model storage, NOT vault storage.
   * We don't check isModelInstalled() because that checks the wrong storage system.
   * WebLLM will automatically use cached model if available, or download if not.
   */
  async loadModel(): Promise<void> {
    if (!this.adapter || this.isLoading) return;

    const modelSpec = WEBLLM_MODELS[0];
    if (!modelSpec) {
      return;
    }

    this.isLoading = true;
    this.callbacks.onLoadingStart?.();

    try {
      await this.adapter.loadModel(modelSpec, (progress, stage) => {
        this.callbacks.onLoadingProgress?.(progress, stage);
      });

      this.isLoading = false;
      this.lastActivityTime = Date.now();
      this.callbacks.onLoadingComplete?.();

      new Notice('Nexus model loaded', 3000);
    } catch (error) {
      this.isLoading = false;
      const err = error instanceof Error ? error : new Error(String(error));
      this.callbacks.onError?.(err);
      console.error('[NexusLifecycle] Failed to load model:', error);
    }
  }

  /**
   * Unload the model from GPU memory
   */
  async unloadModel(): Promise<void> {
    if (!this.adapter) return;

    if (!this.adapter.isModelLoaded()) {
      return; // Already unloaded
    }

    try {
      await this.adapter.unloadModel();
      this.clearIdleTimer();
      this.callbacks.onUnload?.();

      new Notice('Nexus model unloaded to free GPU memory', 3000);
    } catch (error) {
      console.error('[NexusLifecycle] Failed to unload model:', error);
    }
  }

  /**
   * Start the idle timer
   * Unloads model after IDLE_TIMEOUT_MS of inactivity
   */
  private startIdleTimer(): void {
    if (this.idleTimer) return;

    this.idleTimer = setTimeout(async () => {
      this.idleTimer = null;

      if (!this.adapter?.isModelLoaded()) return;

      const idleTime = Date.now() - this.lastActivityTime;
      if (idleTime >= WebLLMLifecycleManager.IDLE_TIMEOUT_MS) {
        await this.unloadModel();
      }
    }, WebLLMLifecycleManager.IDLE_TIMEOUT_MS);
  }

  /**
   * Clear the idle timer
   */
  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * Check if the model is currently loaded
   */
  isModelLoaded(): boolean {
    return this.adapter?.isModelLoaded() ?? false;
  }

  /**
   * Check if the model is currently loading
   */
  isModelLoading(): boolean {
    return this.isLoading;
  }

  /**
   * Get the current adapter state
   */
  getState() {
    return this.adapter?.getState();
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.clearIdleTimer();
    this.adapter = null;
    this.callbacks = {};
  }
}

// Singleton instance for global access
let lifecycleManagerInstance: WebLLMLifecycleManager | null = null;

/**
 * Get the global WebLLMLifecycleManager instance
 */
export function getWebLLMLifecycleManager(): WebLLMLifecycleManager {
  if (!lifecycleManagerInstance) {
    lifecycleManagerInstance = new WebLLMLifecycleManager();
  }
  return lifecycleManagerInstance;
}

/**
 * Dispose the global instance
 */
export function disposeWebLLMLifecycleManager(): void {
  if (lifecycleManagerInstance) {
    lifecycleManagerInstance.dispose();
    lifecycleManagerInstance = null;
  }
}
