/**
 * GenericProviderModal
 *
 * Provider modal for API-key based providers (OpenAI, Anthropic, Google, etc.).
 * Handles API key input, validation, model toggles, and optional OAuth connect.
 *
 * OAuth banner rendering is delegated to OAuthBannerComponent.
 * OAuth connect/disconnect flows are delegated to OAuthFlowManager.
 */

import { Setting, Notice } from 'obsidian';
import {
  IProviderModal,
  ProviderModalConfig,
  ProviderModalDependencies,
} from '../types';
import { LLMValidationService } from '../../../services/llm/validation/ValidationService';
import { ModelWithProvider } from '../../../services/StaticModelsService';
import { renderOAuthBanner, updateConnectButtonState, renderCliStatusBanner, updateCheckStatusButtonState } from '../../shared/OAuthBannerComponent';
import { OAuthFlowManager } from '../../../services/oauth/OAuthFlowManager';
import { getNexusPlugin } from '../../../utils/pluginLocator';

export class GenericProviderModal implements IProviderModal {
  private config: ProviderModalConfig;
  private deps: ProviderModalDependencies;

  // UI elements
  private container: HTMLElement | null = null;
  private apiKeyInput: HTMLInputElement | null = null;
  private modelsContainer: HTMLElement | null = null;
  private oauthBannerContainer: HTMLElement | null = null;
  private deviceCodeEl: HTMLElement | null = null;
  private connectButton: HTMLButtonElement | null = null;

  // Secondary OAuth UI elements
  private secondaryBannerContainer: HTMLElement | null = null;
  private secondaryConnectButton: HTMLButtonElement | null = null;
  private secondaryCheckStatusButton: HTMLButtonElement | null = null;

  // State
  private apiKey = '';
  private models: ModelWithProvider[] = [];
  private isValidated = false;
  private validationTimeout: ReturnType<typeof setTimeout> | null = null;

  // OAuth flow managers
  private primaryFlowManager: OAuthFlowManager | null = null;
  private secondaryFlowManager: OAuthFlowManager | null = null;

  constructor(config: ProviderModalConfig, deps: ProviderModalDependencies) {
    this.config = config;
    this.deps = deps;
    const primaryOAuthConfig = this.config.oauthConfig;

    // Initialize from existing config
    this.apiKey = config.config.apiKey || '';

    // Set up primary OAuth flow manager
    if (primaryOAuthConfig) {
      this.primaryFlowManager = new OAuthFlowManager({
        oauthConfig: primaryOAuthConfig,
        providerId: config.providerId,
        app: deps.app,
        callbacks: {
          onConnect: (result) => {
            return this.persistPrimaryConfig((config) => {
              this.apiKey = result.apiKey;
              config.apiKey = result.apiKey;

              if (this.apiKeyInput) {
                this.apiKeyInput.value = result.apiKey;
              }

              config.oauth = {
                connected: true,
                providerId: this.config.providerId,
                connectedAt: Date.now(),
                refreshToken: result.refreshToken,
                expiresAt: result.expiresAt,
                metadata: result.metadata,
              };

              config.enabled = true;
            });
          },
          onDisconnect: () => {
            return this.persistPrimaryConfig((config) => {
              this.apiKey = '';
              config.apiKey = '';
              config.oauth = undefined;

              if (this.apiKeyInput) {
                this.apiKeyInput.value = '';
              }
            });
          },
          onConnectingChange: (connecting) => {
            updateConnectButtonState(
              this.connectButton,
              connecting,
              primaryOAuthConfig.providerLabel,
            );
            // Hide device code display when flow ends
            if (!connecting) {
              this.hideDeviceCode();
            }
          },
          onDeviceCode: (userCode, verificationUri) => {
            this.showDeviceCode(userCode, verificationUri);
          },
        },
      });
    }

    // Set up secondary OAuth flow manager (skip for statusOnly — handled via direct startFlow)
    if (config.secondaryOAuthProvider && !config.secondaryOAuthProvider.statusOnly) {
      const secondary = config.secondaryOAuthProvider;
      this.secondaryFlowManager = new OAuthFlowManager({
        oauthConfig: secondary.oauthConfig,
        providerId: secondary.providerId,
        app: deps.app,
        callbacks: {
          onConnect: (result) => {
            return this.persistSecondaryConfig((config) => {
              config.apiKey = result.apiKey;
              config.oauth = {
                connected: true,
                providerId: secondary.providerId,
                connectedAt: Date.now(),
                refreshToken: result.refreshToken,
                expiresAt: result.expiresAt,
                metadata: result.metadata,
              };
              config.enabled = true;
            });
          },
          onDisconnect: () => {
            return this.persistSecondaryConfig((config) => {
              config.apiKey = '';
              config.oauth = undefined;
              config.enabled = false;
            });
          },
          onConnectingChange: (connecting) => {
            updateConnectButtonState(
              this.secondaryConnectButton,
              connecting,
              secondary.oauthConfig.providerLabel,
            );
          },
        },
      });
    }
  }

  /**
   * Render the generic provider configuration UI
   */
  render(container: HTMLElement): void {
    this.container = container;
    container.empty();

    this.renderApiKeySection(container);
    this.renderModelsSection(container);

    if (this.config.secondaryOAuthProvider) {
      this.renderSecondaryOAuthSection(container);
    }
  }

  /**
   * Render API key input section, with optional OAuth connect button and connected banner
   */
  private renderApiKeySection(container: HTMLElement): void {
    container.createEl('h2', { text: this.config.oauthOnly ? 'Authentication' : 'API key' });

    // OAuth connected banner (shown above the key input when connected)
    this.oauthBannerContainer = container.createDiv('oauth-banner-container');
    this.refreshPrimaryBanner();

    // Device code inline display (hidden until a device flow fires onDeviceCode)
    this.deviceCodeEl = container.createDiv('oauth-device-code-container');
    this.deviceCodeEl.addClass('oauth-device-code-hidden');

    // OAuth-only providers (e.g. GitHub Copilot) don't have a manual key input
    if (this.config.oauthOnly) return;

    new Setting(container)
      .setDesc(`Enter your ${this.config.providerName} API key (format: ${this.config.keyFormat})`)
      .addText(text => {
        this.apiKeyInput = text.inputEl;
        this.apiKeyInput.type = 'password';
        this.apiKeyInput.addClass('llm-provider-input');

        text
          .setPlaceholder(`Enter your ${this.config.providerName} API key`)
          .setValue(this.apiKey)
          .onChange(value => {
            this.apiKey = value;
            this.handleApiKeyChange(value);
          });
      })
      .addButton(button => {
        button
          .setButtonText('Get key')
          .setTooltip(`Open ${this.config.providerName} API key page`)
          .onClick(() => {
            window.open(this.config.signupUrl, '_blank');
          });
      });
  }

  /**
   * Show the device code inline for the user to copy and enter
   */
  private showDeviceCode(userCode: string, verificationUri: string): void {
    if (!this.deviceCodeEl) return;

    this.deviceCodeEl.empty();
    this.deviceCodeEl.removeClass('oauth-device-code-hidden');

    this.deviceCodeEl.createEl('p', {
      text: 'Enter this code at github.com/login/device:',
      cls: 'oauth-device-code-instruction',
    });

    const row = this.deviceCodeEl.createDiv('oauth-device-code-row');
    row.createSpan({ text: userCode, cls: 'oauth-device-code-value' });

    const copyBtn = row.createEl('button', { text: 'Copy' });
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard.writeText(userCode);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
      }, 2000);
    });

    this.deviceCodeEl.createEl('p', {
      text: `Browser opened to ${verificationUri}`,
      cls: 'oauth-device-code-url',
    });
  }

  /**
   * Hide and clear the device code display
   */
  private hideDeviceCode(): void {
    if (!this.deviceCodeEl) return;
    this.deviceCodeEl.addClass('oauth-device-code-hidden');
    this.deviceCodeEl.empty();
  }

  /**
   * Refresh the primary OAuth banner
   */
  private refreshPrimaryBanner(): void {
    if (!this.oauthBannerContainer || !this.config.oauthConfig) return;

    this.hideDeviceCode();

    const result = renderOAuthBanner(this.oauthBannerContainer, {
      providerLabel: this.config.oauthConfig.providerLabel,
      isConnected: !!this.config.config.oauth?.connected,
      onConnect: () => this.primaryFlowManager?.connect(),
      onDisconnect: () => this.primaryFlowManager?.disconnect(),
    });
    this.connectButton = result.connectButton;
  }

  /**
   * Render a secondary OAuth provider sub-section (e.g., Codex inside OpenAI modal)
   */
  private renderSecondaryOAuthSection(container: HTMLElement): void {
    const secondary = this.config.secondaryOAuthProvider;
    if (!secondary) return;

    const section = container.createDiv('secondary-oauth-section');

    section.createEl('h2', { text: secondary.providerLabel });
    section.createEl('p', {
      text: secondary.description,
      cls: 'setting-item-description',
    });

    // Banner container for connected/disconnected or status indicator
    this.secondaryBannerContainer = section.createDiv('oauth-banner-container');
    this.refreshSecondaryBanner();
  }

  /**
   * Refresh the secondary OAuth/CLI status banner
   */
  private refreshSecondaryBanner(): void {
    if (!this.secondaryBannerContainer) return;

    const secondary = this.config.secondaryOAuthProvider;
    if (!secondary) return;

    if (secondary.statusOnly) {
      // CLI status indicator: shows authenticated/not-authenticated + "Check status" button
      const result = renderCliStatusBanner(this.secondaryBannerContainer, {
        providerLabel: secondary.oauthConfig.providerLabel,
        isAuthenticated: !!secondary.config.oauth?.connected,
        notAuthenticatedHint: secondary.statusHint,
        onCheckStatus: () => {
          void this.checkSecondaryCliStatus();
        },
      });
      this.secondaryCheckStatusButton = result.checkStatusButton;
    } else {
      // Standard OAuth connect/disconnect banner
      const result = renderOAuthBanner(this.secondaryBannerContainer, {
        providerLabel: secondary.oauthConfig.providerLabel,
        isConnected: !!secondary.config.oauth?.connected,
        onConnect: () => this.secondaryFlowManager?.connect(),
        onDisconnect: () => this.secondaryFlowManager?.disconnect(),
      });
      this.secondaryConnectButton = result.connectButton;
    }
  }

  /**
   * Run a CLI status check for a statusOnly secondary provider.
   * Calls startFlow (which is check-only), updates config on success,
   * and refreshes the status banner.
   */
  private async checkSecondaryCliStatus(): Promise<void> {
    const secondary = this.config.secondaryOAuthProvider;
    if (!secondary) return;

    updateCheckStatusButtonState(this.secondaryCheckStatusButton, true);
    let persistenceAttempted = false;

    try {
      const result = await secondary.oauthConfig.startFlow({});

      if (result.success && result.apiKey) {
        const apiKey = result.apiKey;
        persistenceAttempted = true;
        await this.persistSecondaryConfig((config) => {
          config.apiKey = apiKey;
          config.oauth = {
            connected: true,
            providerId: secondary.providerId,
            connectedAt: Date.now(),
            metadata: result.metadata,
          };
          config.enabled = true;
        });
        new Notice(`${secondary.oauthConfig.providerLabel} authenticated`);
      } else {
        persistenceAttempted = true;
        await this.persistSecondaryConfig((config) => {
          config.apiKey = '';
          config.oauth = undefined;
          config.enabled = false;
        });
        new Notice(result.error || `${secondary.oauthConfig.providerLabel} not authenticated`);
      }
    } catch (error) {
      if (!persistenceAttempted) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        new Notice(`Status check failed: ${errorMessage}`);
      }
    } finally {
      updateCheckStatusButtonState(this.secondaryCheckStatusButton, false);
      this.refreshSecondaryBanner();
    }
  }

  /**
   * Handle API key input changes
   */
  private handleApiKeyChange(value: string): void {
    this.isValidated = false;

    if (this.apiKeyInput) {
      this.apiKeyInput.removeClass('success');
      this.apiKeyInput.removeClass('error');
    }

    // Clear validation cache
    this.config.config.lastValidated = undefined;
    this.config.config.validationHash = undefined;

    // Clear OAuth badge if user manually types a key
    if (this.config.config.oauth?.connected) {
      this.config.config.oauth = undefined;
      this.refreshPrimaryBanner();
    }

    // Clear existing timeout
    if (this.validationTimeout) {
      clearTimeout(this.validationTimeout);
      this.validationTimeout = null;
    }

    if (value.trim()) {
      this.apiKeyInput?.addClass('validating');

      // Auto-validate after delay
      this.validationTimeout = setTimeout(() => {
        void this.validateApiKey();
      }, 2000);

      // Auto-enable
      if (!this.config.config.enabled) {
        this.config.config.enabled = true;
        this.saveConfig();
      }
    } else {
      this.apiKeyInput?.removeClass('validating');
    }
  }

  /**
   * Render models section
   */
  private renderModelsSection(container: HTMLElement): void {
    container.createEl('h2', { text: 'Available models' });
    this.modelsContainer = container.createDiv('models-container');

    this.loadModels();
  }

  /**
   * Load models from static service
   */
  private loadModels(): void {
    if (!this.modelsContainer) return;

    try {
      const plugin = getNexusPlugin(this.deps.app) as { settings?: { settings?: { enableIngestion?: boolean } } } | null;
      const includeIngestionModels = plugin?.settings?.settings?.enableIngestion !== false;
      this.models = this.deps.staticModelsService.getConfigurableModelsForProvider(
        this.config.providerId,
        { includeIngestionModels }
      );
      this.displayModels();
    } catch (error) {
      console.error('[GenericProvider] Error loading models:', error);
      this.modelsContainer.empty();
      const errorDiv = this.modelsContainer.createDiv('models-error');
      const titleP = errorDiv.createEl('p');
      titleP.createEl('strong', { text: 'Error loading models:' });
      errorDiv.createEl('p', { text: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  /**
   * Display loaded models with toggles
   */
  private displayModels(): void {
    if (!this.modelsContainer) return;
    this.modelsContainer.empty();

    if (this.models.length === 0) {
      this.modelsContainer.createDiv('models-empty')
        .textContent = 'No models available. Check your API key and try again.';
      return;
    }

    const modelsList = this.modelsContainer.createDiv('models-list');

    this.models.forEach(model => {
      const modelEl = modelsList.createDiv('model-item');

      const modelRow = modelEl.createDiv('model-row');
      modelRow.addClass('llm-provider-model-row');

      // Model name
      const modelNameEl = modelRow.createDiv('model-name llm-provider-model-name');
      modelNameEl.textContent = model.name;

      // Model toggle
      const currentEnabled = this.config.config.models?.[model.id]?.enabled ?? true;
      const toggleContainer = modelRow.createDiv('model-toggle-container');
      toggleContainer.addClass('llm-provider-model-toggle');

      new Setting(toggleContainer)
        .addToggle(toggle => toggle
          .setValue(currentEnabled)
          .onChange(enabled => {
            // Initialize models object if needed
            if (!this.config.config.models) {
              this.config.config.models = {};
            }
            if (!this.config.config.models[model.id]) {
              this.config.config.models[model.id] = { enabled: true };
            }

            this.config.config.models[model.id].enabled = enabled;
            this.saveConfig();
          })
        );
    });
  }

  /**
   * Validate API key
   */
  private async validateApiKey(): Promise<void> {
    const apiKey = this.apiKey.trim();

    if (!apiKey) {
      new Notice('Please enter an API key first');
      return;
    }

    this.apiKeyInput?.removeClass('success');
    this.apiKeyInput?.removeClass('error');
    this.apiKeyInput?.addClass('validating');

    try {
      const result = await LLMValidationService.validateApiKey(
        this.config.providerId,
        apiKey,
        {
          forceValidation: true,
          providerConfig: this.config.config,
          onValidationSuccess: (hash: string, timestamp: number) => {
            this.config.config.lastValidated = timestamp;
            this.config.config.validationHash = hash;
          }
        }
      );

      if (result.success) {
        this.isValidated = true;
        this.apiKeyInput?.removeClass('validating');
        this.apiKeyInput?.removeClass('error');
        this.apiKeyInput?.addClass('success');

        this.config.config.apiKey = apiKey;
        this.config.config.enabled = true;
        this.saveConfig();

        new Notice(`${this.config.providerName} API key validated successfully!`);
      } else {
        throw new Error(result.error || 'API key validation failed');
      }

    } catch (error) {
      console.error('[GenericProvider] Validation failed:', error);

      this.isValidated = false;
      this.apiKeyInput?.removeClass('validating');
      this.apiKeyInput?.removeClass('success');
      this.apiKeyInput?.addClass('error');

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`${this.config.providerName} API key validation failed: ${errorMessage}`);
    }
  }

  /**
   * Save configuration
   */
  private saveConfig(): void {
    void this.config.onConfigChange(this.config.config);
  }

  private cloneProviderConfig(config: import('../../../types').LLMProviderConfig): import('../../../types').LLMProviderConfig {
    return {
      ...config,
      oauth: config.oauth ? {
        ...config.oauth,
        metadata: config.oauth.metadata ? { ...config.oauth.metadata } : undefined,
      } : undefined,
    };
  }

  private async persistPrimaryConfig(
    applyChange: (config: import('../../../types').LLMProviderConfig) => void,
  ): Promise<void> {
    const previousConfig = this.cloneProviderConfig(this.config.config);
    const previousApiKey = this.apiKey;
    const previousInputValue = this.apiKeyInput?.value;

    applyChange(this.config.config);

    try {
      await Promise.resolve(this.config.onConfigChange(this.config.config));
    } catch (error) {
      this.config.config = previousConfig;
      this.apiKey = previousApiKey;
      if (this.apiKeyInput) {
        this.apiKeyInput.value = previousInputValue ?? '';
      }
      throw error;
    } finally {
      this.refreshPrimaryBanner();
    }
  }

  private async persistSecondaryConfig(
    applyChange: (config: import('../../../types').LLMProviderConfig) => void,
  ): Promise<void> {
    const secondary = this.config.secondaryOAuthProvider;
    if (!secondary) return;

    const previousConfig = this.cloneProviderConfig(secondary.config);
    applyChange(secondary.config);

    try {
      await secondary.onConfigChange(secondary.config);
    } catch (error) {
      secondary.config = previousConfig;
      throw error;
    } finally {
      this.refreshSecondaryBanner();
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): import('../../../types').LLMProviderConfig {
    return {
      ...this.config.config,
      apiKey: this.apiKey,
    };
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.validationTimeout) {
      clearTimeout(this.validationTimeout);
      this.validationTimeout = null;
    }

    // Cancel any in-progress OAuth flow so the callback server shuts down
    this.primaryFlowManager?.cancelIfActive();
    this.secondaryFlowManager?.cancelIfActive();

    this.container = null;
    this.apiKeyInput = null;
    this.modelsContainer = null;
    this.oauthBannerContainer = null;
    this.deviceCodeEl = null;
    this.connectButton = null;
    this.secondaryBannerContainer = null;
    this.secondaryConnectButton = null;
    this.secondaryCheckStatusButton = null;
  }
}
