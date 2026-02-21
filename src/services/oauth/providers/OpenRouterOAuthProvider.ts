/**
 * OpenRouterOAuthProvider.ts
 * Location: src/services/oauth/providers/OpenRouterOAuthProvider.ts
 *
 * OAuth 2.0 PKCE provider for OpenRouter. The flow produces a permanent
 * API key (sk-or-...) identical to manually created keys -- no token
 * refresh needed. Supports optional pre-auth params for key_label and
 * credit_limit.
 *
 * Used by: OAuthService (registered at startup via main.ts)
 * Reference: docs/preparation/openrouter-oauth-research.md
 */

import { IOAuthProvider, OAuthProviderConfig, OAuthResult } from '../IOAuthProvider';

/** OpenRouter authorization page */
const AUTH_URL = 'https://openrouter.ai/auth';

/** Token exchange endpoint -- returns a permanent API key */
const TOKEN_URL = 'https://openrouter.ai/api/v1/auth/keys';

export class OpenRouterOAuthProvider implements IOAuthProvider {
  readonly config: OAuthProviderConfig = {
    providerId: 'openrouter',
    displayName: 'OpenRouter',
    authUrl: AUTH_URL,
    tokenUrl: TOKEN_URL,
    preferredPort: 3000,
    callbackPath: '/callback',
    scopes: [],
    tokenType: 'permanent-key',
    clientId: '',
  };

  /**
   * Build the OpenRouter authorization URL.
   *
   * OpenRouter uses a simplified OAuth flow: the auth page accepts
   * callback_url, code_challenge, code_challenge_method, and state.
   * Optional preAuthParams support key_label (name for the key in
   * OpenRouter dashboard) and credit_limit (spending cap in USD).
   */
  buildAuthUrl(
    callbackUrl: string,
    codeChallenge: string,
    state: string,
    preAuthParams?: Record<string, string>
  ): string {
    const params = new URLSearchParams({
      callback_url: callbackUrl,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    });

    // Add optional pre-auth parameters
    if (preAuthParams?.key_label) {
      params.set('key_label', preAuthParams.key_label);
    }
    if (preAuthParams?.credit_limit) {
      params.set('limit', preAuthParams.credit_limit);
    }

    return `${AUTH_URL}?${params.toString()}`;
  }

  /**
   * Exchange the authorization code for a permanent OpenRouter API key.
   *
   * POST to /api/v1/auth/keys with the code, code_verifier, and
   * code_challenge_method. Returns { key: "sk-or-..." }.
   */
  async exchangeCode(
    code: string,
    codeVerifier: string,
    _callbackUrl: string
  ): Promise<OAuthResult> {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        code_challenge_method: 'S256',
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `OpenRouter token exchange failed: HTTP ${response.status} - ${body}`
      );
    }

    const data: { key: string } = await response.json();

    if (!data.key) {
      throw new Error('OpenRouter token exchange returned no key');
    }

    return {
      apiKey: data.key,
    };
  }

  // No refreshToken needed -- OpenRouter keys are permanent
}
