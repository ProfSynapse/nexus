/**
 * IOAuthProvider.ts
 * Location: src/services/oauth/IOAuthProvider.ts
 *
 * Defines the core interfaces for the OAuth 2.0 PKCE provider system.
 * All OAuth providers implement IOAuthProvider. OAuthState is persisted
 * on LLMProviderConfig to track connection status. OAuthResult is the
 * transient result returned after a successful OAuth flow.
 *
 * Used by: OAuthService (orchestrates flows), provider implementations
 * (OpenRouter, Codex), ProviderTypes.ts (re-exports OAuthState), and
 * the settings UI (reads OAuthProviderConfig for button rendering).
 */

/**
 * Static configuration for an OAuth provider. Describes the provider's
 * endpoints, port preference, scopes, and display metadata. Immutable
 * after construction.
 */
export interface OAuthProviderConfig {
  /** Matches SupportedProvider enum value (e.g., 'openrouter', 'openai-codex') */
  providerId: string;
  /** Human-readable label for the UI (e.g., "OpenRouter", "ChatGPT (Experimental)") */
  displayName: string;
  /** Authorization endpoint URL */
  authUrl: string;
  /** Token exchange endpoint URL */
  tokenUrl: string;
  /** Preferred localhost port for the OAuth callback server */
  preferredPort: number;
  /** Path for the callback route (e.g., '/callback' or '/auth/callback') */
  callbackPath: string;
  /** OAuth scopes to request (empty array if provider doesn't use scopes) */
  scopes: string[];
  /** Whether tokens are permanent API keys or expiring access tokens */
  tokenType: 'permanent-key' | 'expiring-token';
  /** OAuth client ID (empty string if none required, e.g., OpenRouter) */
  clientId: string;
  /** If true, UI shows a consent/warning dialog before starting the flow */
  experimental?: boolean;
  /** Warning text displayed in the consent dialog for experimental providers */
  experimentalWarning?: string;
}

/**
 * Transient result from a completed OAuth flow. Contains the API key
 * (or access token) and optional refresh/expiry data for providers
 * that issue expiring tokens.
 */
export interface OAuthResult {
  /** The key or access token to store in LLMProviderConfig.apiKey */
  apiKey: string;
  /** Refresh token for expiring-token providers (Codex) */
  refreshToken?: string;
  /** Expiration timestamp in Unix milliseconds (for expiring-token providers) */
  expiresAt?: number;
  /** Provider-specific metadata (e.g., { accountId, idToken }) */
  metadata?: Record<string, string>;
}

/**
 * Contract for OAuth provider implementations. Each provider knows how
 * to build its authorization URL and exchange an authorization code for
 * tokens. Providers with expiring tokens also implement refreshToken().
 */
export interface IOAuthProvider {
  /** Static configuration describing this provider */
  readonly config: OAuthProviderConfig;

  /**
   * Build the full authorization URL that opens in the user's browser.
   * @param callbackUrl - The localhost callback URL (e.g., http://127.0.0.1:3000/callback)
   * @param codeChallenge - Base64url-encoded S256 PKCE challenge
   * @param state - Random state string for CSRF protection
   * @param preAuthParams - Optional provider-specific params (e.g., key_label for OpenRouter)
   * @returns Full authorization URL string
   */
  buildAuthUrl(
    callbackUrl: string,
    codeChallenge: string,
    state: string,
    preAuthParams?: Record<string, string>
  ): string;

  /**
   * Exchange an authorization code for tokens/API key.
   * @param code - Authorization code from the callback
   * @param codeVerifier - Original PKCE code verifier (never logged or persisted)
   * @param callbackUrl - The callback URL used during authorization (must match exactly)
   * @returns OAuthResult with the API key and optional token data
   */
  exchangeCode(
    code: string,
    codeVerifier: string,
    callbackUrl: string
  ): Promise<OAuthResult>;

  /**
   * Refresh an expired access token. Only implemented by providers with
   * tokenType === 'expiring-token'. Returns null if refresh fails
   * (user must re-authenticate).
   */
  refreshToken?(refreshToken: string): Promise<OAuthResult | null>;
}

/**
 * Persistent OAuth state stored on LLMProviderConfig.oauth. Tracks
 * whether a provider was connected via OAuth and holds token data
 * needed for refresh flows.
 */
export interface OAuthState {
  /** Whether this provider is currently OAuth-connected */
  connected: boolean;
  /** The provider ID that was used for OAuth (e.g., 'openrouter') */
  providerId: string;
  /** Timestamp (Unix ms) when the OAuth connection was established */
  connectedAt: number;
  /** Refresh token for expiring-token providers */
  refreshToken?: string;
  /** Token expiration timestamp (Unix ms) for expiring-token providers */
  expiresAt?: number;
  /** Provider-specific metadata (e.g., accountId for Codex) */
  metadata?: Record<string, string>;
}
