/**
 * OAuthFlowManager
 *
 * Shared connect/disconnect flow logic for OAuth providers.
 * Extracted from GenericProviderModal to eliminate duplication between
 * primary and secondary OAuth provider flows.
 */

import { App, Notice } from 'obsidian';
import { OAuthModalConfig } from '../../components/llm-provider/types';
import { OAuthConsentModal, OAuthPreAuthModal } from '../../components/llm-provider/providers/OAuthModals';
import { OAuthService } from './OAuthService';

/**
 * Result of a successful OAuth connection
 */
export interface OAuthConnectResult {
  apiKey: string;
  refreshToken?: string;
  expiresAt?: number;
  metadata?: Record<string, string>;
}

/**
 * Callbacks for OAuth flow events
 */
export interface OAuthFlowCallbacks {
  /** Called on successful connection with the result data */
  onConnect: (result: OAuthConnectResult) => void;
  /** Called on disconnect */
  onDisconnect: () => void;
  /** Called when connecting state changes (for UI updates) */
  onConnectingChange: (connecting: boolean) => void;
  /** Called when a device flow provides a user code for manual entry */
  onDeviceCode?: (userCode: string, verificationUri: string) => void;
}

/**
 * Configuration for an OAuthFlowManager instance
 */
export interface OAuthFlowConfig {
  /** The OAuth modal config (provider label, startFlow, etc.) */
  oauthConfig: OAuthModalConfig;
  /** Provider ID for the OAuth state */
  providerId: string;
  /** The Obsidian app instance (needed for modals) */
  app: App;
  /** Callbacks for flow events */
  callbacks: OAuthFlowCallbacks;
}

/**
 * Manages a single OAuth connect/disconnect flow.
 * One instance per OAuth provider (primary or secondary).
 */
export class OAuthFlowManager {
  private config: OAuthFlowConfig;
  private isConnecting: boolean = false;

  constructor(config: OAuthFlowConfig) {
    this.config = config;
  }

  /**
   * Whether a connect flow is currently in progress
   */
  get connecting(): boolean {
    return this.isConnecting;
  }

  /**
   * Handle the OAuth connect button click.
   * Shows consent/pre-auth modals if needed, then executes the flow.
   */
  async connect(): Promise<void> {
    if (this.isConnecting) return;

    const { oauthConfig } = this.config;
    const hasPreAuthFields = oauthConfig.preAuthFields && oauthConfig.preAuthFields.length > 0;

    // Experimental provider: always show consent modal (includes pre-auth fields)
    if (oauthConfig.experimental) {
      new OAuthConsentModal(
        this.config.app,
        oauthConfig,
        (params) => this.executeFlow(params),
        () => { /* cancelled */ },
      ).open();
      return;
    }

    // Non-experimental with pre-auth fields: show pre-auth modal
    if (hasPreAuthFields) {
      new OAuthPreAuthModal(
        this.config.app,
        oauthConfig,
        (params) => this.executeFlow(params),
        () => { /* cancelled */ },
      ).open();
      return;
    }

    // No consent or pre-auth needed: start flow directly
    await this.executeFlow({});
  }

  /**
   * Handle OAuth disconnect
   */
  disconnect(): void {
    this.config.callbacks.onDisconnect();
    new Notice(`Disconnected from ${this.config.oauthConfig.providerLabel}`);
  }

  /**
   * Cancel any in-progress flow (for cleanup)
   */
  cancelIfActive(): void {
    if (this.isConnecting) {
      OAuthService.getInstance().cancelFlow();
    }
  }

  /**
   * Execute the OAuth flow and handle the result
   */
  private async executeFlow(params: Record<string, string>): Promise<void> {
    this.setConnecting(true);

    try {
      const result = await this.config.oauthConfig.startFlow(params, this.config.callbacks.onDeviceCode);

      if (result.success && result.apiKey) {
        this.config.callbacks.onConnect({
          apiKey: result.apiKey,
          refreshToken: result.refreshToken,
          expiresAt: result.expiresAt,
          metadata: result.metadata,
        });

        new Notice(`Connected to ${this.config.oauthConfig.providerLabel} successfully`);
      } else {
        const errorMsg = result.error || 'OAuth flow failed';
        new Notice(`${this.config.oauthConfig.providerLabel} connection failed: ${errorMsg}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      new Notice(`${this.config.oauthConfig.providerLabel} connection failed: ${errorMsg}`);
    } finally {
      this.setConnecting(false);
    }
  }

  private setConnecting(connecting: boolean): void {
    this.isConnecting = connecting;
    this.config.callbacks.onConnectingChange(connecting);
  }
}
