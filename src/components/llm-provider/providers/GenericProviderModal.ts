/**
 * GenericProviderModal
 *
 * Provider modal for API-key based providers (OpenAI, Anthropic, Google, etc.).
 * Handles API key input, validation, model toggles, and optional OAuth connect.
 */

import { Setting, Notice } from 'obsidian';
import {
  IProviderModal,
  ProviderModalConfig,
  ProviderModalDependencies,
  OAuthModalConfig,
  SecondaryOAuthProviderConfig,
} from '../types';
import { LLMValidationService } from '../../../services/llm/validation/ValidationService';
import { ModelWithProvider } from '../../../services/StaticModelsService';
import { OAuthConsentModal, OAuthPreAuthModal } from './OAuthModals';
import { OAuthService } from '../../../services/oauth/OAuthService';

export class GenericProviderModal implements IProviderModal {
  private config: ProviderModalConfig;
  private deps: ProviderModalDependencies;

  // UI elements
  private container: HTMLElement | null = null;
  private apiKeyInput: HTMLInputElement | null = null;
  private modelsContainer: HTMLElement | null = null;
  private oauthBannerContainer: HTMLElement | null = null;
  private connectButton: HTMLButtonElement | null = null;

  // Secondary OAuth UI elements
  private secondaryBannerContainer: HTMLElement | null = null;
  private secondaryConnectButton: HTMLButtonElement | null = null;

  // State
  private apiKey: string = '';
  private models: ModelWithProvider[] = [];
  private isValidated: boolean = false;
  private isOAuthConnecting: boolean = false;
  private isSecondaryOAuthConnecting: boolean = false;
  private validationTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ProviderModalConfig, deps: ProviderModalDependencies) {
    this.config = config;
    this.deps = deps;

    // Initialize from existing config
    this.apiKey = config.config.apiKey || '';
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
    container.createEl('h2', { text: 'API key' });

    // OAuth connected banner (shown above the key input when connected)
    this.oauthBannerContainer = container.createDiv('oauth-banner-container');
    this.renderOAuthBanner();

    const setting = new Setting(container)
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
   * Render the OAuth banner area: connected banner when connected,
   * standalone connect button when disconnected but OAuth is available
   */
  private renderOAuthBanner(): void {
    if (!this.oauthBannerContainer) return;
    this.oauthBannerContainer.empty();

    if (!this.config.oauthConfig) return;

    const oauthState = this.config.config.oauth;

    if (oauthState?.connected) {
      // Connected state: show connected banner with disconnect button
      const banner = this.oauthBannerContainer.createDiv('oauth-connected-banner');

      const statusText = banner.createSpan('oauth-connected-status');
      statusText.textContent = `Connected via ${this.config.oauthConfig.providerLabel}`;

      const disconnectBtn = banner.createEl('button', {
        text: 'Disconnect',
        cls: 'oauth-disconnect-btn',
      });
      disconnectBtn.setAttribute('aria-label', `Disconnect ${this.config.oauthConfig.providerLabel} OAuth`);
      disconnectBtn.onclick = () => this.handleOAuthDisconnect();
    } else {
      // Disconnected state: show standalone connect button
      const connectDiv = this.oauthBannerContainer.createDiv('oauth-connect-standalone');
      const label = this.config.oauthConfig.providerLabel;
      this.connectButton = connectDiv.createEl('button', {
        text: `Connect with ${label}`,
        cls: 'mod-cta oauth-connect-btn',
      });
      this.connectButton.setAttribute('aria-label', `Connect with ${label} via OAuth`);
      this.connectButton.onclick = () => this.handleOAuthConnect();
    }
  }

  /**
   * Handle the OAuth connect button click
   */
  private async handleOAuthConnect(): Promise<void> {
    const oauthConfig = this.config.oauthConfig;
    if (!oauthConfig || this.isOAuthConnecting) return;

    const hasPreAuthFields = oauthConfig.preAuthFields && oauthConfig.preAuthFields.length > 0;

    // Experimental provider: always show consent modal (includes pre-auth fields)
    if (oauthConfig.experimental) {
      new OAuthConsentModal(
        this.deps.app,
        oauthConfig,
        (params) => this.executeOAuthFlow(oauthConfig, params),
        () => { /* cancelled */ },
      ).open();
      return;
    }

    // Non-experimental with pre-auth fields: show pre-auth modal
    if (hasPreAuthFields) {
      new OAuthPreAuthModal(
        this.deps.app,
        oauthConfig,
        (params) => this.executeOAuthFlow(oauthConfig, params),
        () => { /* cancelled */ },
      ).open();
      return;
    }

    // No consent or pre-auth needed: start flow directly
    await this.executeOAuthFlow(oauthConfig, {});
  }

  /**
   * Execute the OAuth flow and handle the result
   */
  private async executeOAuthFlow(
    oauthConfig: OAuthModalConfig,
    params: Record<string, string>,
  ): Promise<void> {
    this.setOAuthConnecting(true);

    try {
      const result = await oauthConfig.startFlow(params);

      if (result.success && result.apiKey) {
        // Update API key
        this.apiKey = result.apiKey;
        this.config.config.apiKey = result.apiKey;

        if (this.apiKeyInput) {
          this.apiKeyInput.value = result.apiKey;
        }

        // Set OAuth state
        this.config.config.oauth = {
          connected: true,
          providerId: this.config.providerId,
          connectedAt: Date.now(),
          refreshToken: result.refreshToken,
          expiresAt: result.expiresAt,
          metadata: result.metadata,
        };

        // Auto-enable the provider
        this.config.config.enabled = true;
        this.saveConfig();

        // Refresh the banner
        this.renderOAuthBanner();

        new Notice(`Connected to ${oauthConfig.providerLabel} successfully`);
      } else {
        const errorMsg = result.error || 'OAuth flow failed';
        new Notice(`${oauthConfig.providerLabel} connection failed: ${errorMsg}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`${oauthConfig.providerLabel} connection failed: ${errorMsg}`);
    } finally {
      this.setOAuthConnecting(false);
    }
  }

  /**
   * Handle OAuth disconnect
   */
  private handleOAuthDisconnect(): void {
    this.apiKey = '';
    this.config.config.apiKey = '';
    this.config.config.oauth = undefined;

    if (this.apiKeyInput) {
      this.apiKeyInput.value = '';
    }

    this.saveConfig();
    this.renderOAuthBanner();

    new Notice(`Disconnected from ${this.config.oauthConfig?.providerLabel || 'provider'}`);
  }

  /**
   * Update the connect button state during OAuth flow
   */
  private setOAuthConnecting(connecting: boolean): void {
    this.isOAuthConnecting = connecting;
    if (!this.connectButton || !this.config.oauthConfig) return;

    if (connecting) {
      this.connectButton.textContent = 'Connecting...';
      this.connectButton.disabled = true;
      this.connectButton.addClass('oauth-connecting');
    } else {
      const label = this.config.oauthConfig.providerLabel;
      this.connectButton.textContent = `Connect with ${label}`;
      this.connectButton.disabled = false;
      this.connectButton.removeClass('oauth-connecting');
    }
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

    // Banner container for connected/disconnected state
    this.secondaryBannerContainer = section.createDiv('oauth-banner-container');
    this.renderSecondaryOAuthBanner();
  }

  /**
   * Render the secondary OAuth banner: connected banner or connect button
   */
  private renderSecondaryOAuthBanner(): void {
    if (!this.secondaryBannerContainer) return;
    this.secondaryBannerContainer.empty();

    const secondary = this.config.secondaryOAuthProvider;
    if (!secondary) return;

    const oauthState = secondary.config.oauth;

    if (oauthState?.connected) {
      const banner = this.secondaryBannerContainer.createDiv('oauth-connected-banner');

      const statusText = banner.createSpan('oauth-connected-status');
      statusText.textContent = `Connected via ${secondary.oauthConfig.providerLabel}`;

      const disconnectBtn = banner.createEl('button', {
        text: 'Disconnect',
        cls: 'oauth-disconnect-btn',
      });
      disconnectBtn.setAttribute('aria-label', `Disconnect ${secondary.oauthConfig.providerLabel} OAuth`);
      disconnectBtn.onclick = () => this.handleSecondaryOAuthDisconnect();
    } else {
      const connectDiv = this.secondaryBannerContainer.createDiv('oauth-connect-standalone');
      const label = secondary.oauthConfig.providerLabel;
      this.secondaryConnectButton = connectDiv.createEl('button', {
        text: `Connect with ${label}`,
        cls: 'mod-cta oauth-connect-btn',
      });
      this.secondaryConnectButton.setAttribute('aria-label', `Connect with ${label} via OAuth`);
      this.secondaryConnectButton.onclick = () => this.handleSecondaryOAuthConnect();
    }
  }

  /**
   * Handle secondary OAuth connect button click
   */
  private async handleSecondaryOAuthConnect(): Promise<void> {
    const secondary = this.config.secondaryOAuthProvider;
    if (!secondary || this.isSecondaryOAuthConnecting) return;

    const oauthConfig = secondary.oauthConfig;

    // Experimental provider: show consent modal
    if (oauthConfig.experimental) {
      new OAuthConsentModal(
        this.deps.app,
        oauthConfig,
        (params) => this.executeSecondaryOAuthFlow(secondary, params),
        () => { /* cancelled */ },
      ).open();
      return;
    }

    // Pre-auth fields: show pre-auth modal
    const hasPreAuthFields = oauthConfig.preAuthFields && oauthConfig.preAuthFields.length > 0;
    if (hasPreAuthFields) {
      new OAuthPreAuthModal(
        this.deps.app,
        oauthConfig,
        (params) => this.executeSecondaryOAuthFlow(secondary, params),
        () => { /* cancelled */ },
      ).open();
      return;
    }

    // No consent or pre-auth: start directly
    await this.executeSecondaryOAuthFlow(secondary, {});
  }

  /**
   * Execute the secondary OAuth flow and handle the result
   */
  private async executeSecondaryOAuthFlow(
    secondary: SecondaryOAuthProviderConfig,
    params: Record<string, string>,
  ): Promise<void> {
    this.setSecondaryOAuthConnecting(true);

    try {
      const result = await secondary.oauthConfig.startFlow(params);

      if (result.success && result.apiKey) {
        secondary.config.apiKey = result.apiKey;
        secondary.config.oauth = {
          connected: true,
          providerId: secondary.providerId,
          connectedAt: Date.now(),
          refreshToken: result.refreshToken,
          expiresAt: result.expiresAt,
          metadata: result.metadata,
        };
        secondary.config.enabled = true;
        secondary.onConfigChange(secondary.config);

        this.renderSecondaryOAuthBanner();

        new Notice(`Connected to ${secondary.oauthConfig.providerLabel} successfully`);
      } else {
        const errorMsg = result.error || 'OAuth flow failed';
        new Notice(`${secondary.oauthConfig.providerLabel} connection failed: ${errorMsg}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`${secondary.oauthConfig.providerLabel} connection failed: ${errorMsg}`);
    } finally {
      this.setSecondaryOAuthConnecting(false);
    }
  }

  /**
   * Handle secondary OAuth disconnect
   */
  private handleSecondaryOAuthDisconnect(): void {
    const secondary = this.config.secondaryOAuthProvider;
    if (!secondary) return;

    secondary.config.apiKey = '';
    secondary.config.oauth = undefined;
    secondary.onConfigChange(secondary.config);

    this.renderSecondaryOAuthBanner();

    new Notice(`Disconnected from ${secondary.oauthConfig.providerLabel}`);
  }

  /**
   * Update the secondary connect button state during OAuth flow
   */
  private setSecondaryOAuthConnecting(connecting: boolean): void {
    this.isSecondaryOAuthConnecting = connecting;
    const secondary = this.config.secondaryOAuthProvider;
    if (!this.secondaryConnectButton || !secondary) return;

    if (connecting) {
      this.secondaryConnectButton.textContent = 'Connecting...';
      this.secondaryConnectButton.disabled = true;
      this.secondaryConnectButton.addClass('oauth-connecting');
    } else {
      const label = secondary.oauthConfig.providerLabel;
      this.secondaryConnectButton.textContent = `Connect with ${label}`;
      this.secondaryConnectButton.disabled = false;
      this.secondaryConnectButton.removeClass('oauth-connecting');
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
      this.renderOAuthBanner();
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
        this.validateApiKey();
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
      this.models = this.deps.staticModelsService.getModelsForProvider(this.config.providerId);
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
    this.config.onConfigChange(this.config.config);
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
    if (this.isOAuthConnecting || this.isSecondaryOAuthConnecting) {
      OAuthService.getInstance().cancelFlow();
    }

    this.container = null;
    this.apiKeyInput = null;
    this.modelsContainer = null;
    this.oauthBannerContainer = null;
    this.connectButton = null;
    this.secondaryBannerContainer = null;
    this.secondaryConnectButton = null;
  }
}
