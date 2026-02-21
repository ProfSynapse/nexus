/**
 * OAuthService.ts
 * Location: src/services/oauth/OAuthService.ts
 *
 * Singleton service that orchestrates OAuth 2.0 PKCE flows. Maintains a
 * registry of IOAuthProvider implementations and coordinates the full
 * flow: PKCE generation, callback server, browser launch, code exchange.
 *
 * State machine: 'idle' -> 'authorizing' -> 'exchanging' -> 'idle'
 * Only one flow can be active at a time.
 *
 * Used by: main.ts (registers providers at startup), settings UI
 * (starts OAuth flows via startFlow()), LLM adapters (refreshes tokens
 * via refreshToken()).
 */

import { IOAuthProvider, OAuthProviderConfig, OAuthResult } from './IOAuthProvider';
import { generateCodeVerifier, generateCodeChallenge, generateState } from './PKCEUtils';
import { startCallbackServer, CallbackServerHandle } from './OAuthCallbackServer';

/** Current state of the OAuth service */
export type OAuthFlowState = 'idle' | 'authorizing' | 'exchanging';

export class OAuthService {
  private static instance: OAuthService;
  private providers: Map<string, IOAuthProvider> = new Map();
  private state: OAuthFlowState = 'idle';
  private activeServerHandle: CallbackServerHandle | null = null;

  private constructor() {
    // Private constructor for singleton pattern
  }

  /**
   * Get the singleton OAuthService instance.
   */
  static getInstance(): OAuthService {
    if (!OAuthService.instance) {
      OAuthService.instance = new OAuthService();
    }
    return OAuthService.instance;
  }

  /**
   * Register an OAuth provider implementation.
   * @param provider - Provider implementing IOAuthProvider
   */
  registerProvider(provider: IOAuthProvider): void {
    this.providers.set(provider.config.providerId, provider);
  }

  /**
   * Check if a provider with the given ID is registered.
   */
  hasProvider(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  /**
   * Get the static configuration for a registered provider.
   * @returns Config or null if provider is not registered
   */
  getProviderConfig(providerId: string): OAuthProviderConfig | null {
    return this.providers.get(providerId)?.config ?? null;
  }

  /**
   * Get the current flow state.
   */
  getState(): OAuthFlowState {
    return this.state;
  }

  /**
   * Start an OAuth PKCE flow for the specified provider.
   *
   * Opens the user's browser to the provider's authorization page,
   * starts a localhost callback server, waits for the callback, and
   * exchanges the authorization code for tokens.
   *
   * @param providerId - ID of the registered provider
   * @param preAuthParams - Optional provider-specific params (e.g., key_label for OpenRouter)
   * @returns OAuthResult with the API key and optional token data
   * @throws Error if provider not found, flow already active, or flow fails
   */
  async startFlow(
    providerId: string,
    preAuthParams?: Record<string, string>
  ): Promise<OAuthResult> {
    // Validate provider exists
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`OAuth provider '${providerId}' is not registered`);
    }

    // Guard against concurrent flows
    if (this.state !== 'idle') {
      throw new Error(
        `Cannot start OAuth flow: another flow is already ${this.state}`
      );
    }

    this.state = 'authorizing';

    try {
      // Generate PKCE parameters
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await generateCodeChallenge(codeVerifier);
      const state = generateState();

      // Start the ephemeral callback server
      const serverHandle = await startCallbackServer({
        port: provider.config.preferredPort,
        callbackPath: provider.config.callbackPath,
        expectedState: state,
      });
      this.activeServerHandle = serverHandle;

      // Build authorization URL and open browser
      const authUrl = provider.buildAuthUrl(
        serverHandle.callbackUrl,
        codeChallenge,
        state,
        preAuthParams
      );

      // Open in system browser via Electron shell (preferred) or window.open (fallback)
      try {
        const { shell } = require('electron');
        shell.openExternal(authUrl);
      } catch {
        window.open(authUrl, '_blank');
      }

      // Wait for the callback
      const callbackResult = await serverHandle.waitForCallback();

      // Exchange the authorization code for tokens
      this.state = 'exchanging';
      const oauthResult = await provider.exchangeCode(
        callbackResult.code,
        codeVerifier,
        serverHandle.callbackUrl
      );

      return oauthResult;
    } finally {
      // Always clean up: shut down callback server and reset state
      if (this.activeServerHandle) {
        this.activeServerHandle.shutdown();
        this.activeServerHandle = null;
      }
      this.state = 'idle';
    }
  }

  /**
   * Cancel an in-progress OAuth flow.
   * Shuts down the callback server if one is active.
   */
  cancelFlow(): void {
    if (this.activeServerHandle) {
      this.activeServerHandle.shutdown();
      this.activeServerHandle = null;
    }
    this.state = 'idle';
  }

  /**
   * Refresh an expired token for a provider.
   *
   * @param providerId - ID of the registered provider
   * @param refreshToken - The current refresh token
   * @returns New OAuthResult with fresh tokens, or null if refresh fails
   * @throws Error if provider not found or doesn't support token refresh
   */
  async refreshToken(
    providerId: string,
    refreshToken: string
  ): Promise<OAuthResult | null> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`OAuth provider '${providerId}' is not registered`);
    }

    if (!provider.refreshToken) {
      throw new Error(
        `OAuth provider '${providerId}' does not support token refresh`
      );
    }

    return provider.refreshToken(refreshToken);
  }

  /**
   * Reset the singleton instance. Useful for testing or plugin unload.
   */
  static resetInstance(): void {
    if (OAuthService.instance) {
      OAuthService.instance.cancelFlow();
      OAuthService.instance.providers.clear();
    }
    OAuthService.instance = undefined as unknown as OAuthService;
  }
}
