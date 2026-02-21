/**
 * OpenAICodexOAuthProvider.ts
 * Location: src/services/oauth/providers/OpenAICodexOAuthProvider.ts
 *
 * Experimental OAuth 2.0 PKCE provider for OpenAI Codex (ChatGPT Plus/Pro).
 * Uses the same client ID and endpoints as Cline, OpenCode, and Roo Code.
 * Tokens are expiring (access_token + refresh_token); the adapter must
 * proactively refresh before each API call.
 *
 * This is marked experimental because it uses an unofficial API that may
 * break without notice. Users must accept a consent dialog before connecting.
 *
 * Used by: OAuthService (registered at startup via main.ts)
 * Reference: docs/preparation/opencode-oauth-source-analysis.md
 * Validated: /tmp/codex-oauth-test/test-codex-oauth.mjs
 */

import { IOAuthProvider, OAuthProviderConfig, OAuthResult } from '../IOAuthProvider';

/** Public OAuth client ID shared across Codex CLI tools (Cline, OpenCode, Roo Code) */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** OpenAI OAuth issuer */
const ISSUER = 'https://auth.openai.com';

/** Authorization endpoint */
const AUTH_ENDPOINT = `${ISSUER}/oauth/authorize`;

/** Token exchange and refresh endpoint */
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;

/**
 * JWT claims structure from OpenAI id_token / access_token.
 * Used to extract the chatgpt_account_id needed for API calls.
 */
interface IdTokenClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  email?: string;
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string;
  };
}

/**
 * Token response from OpenAI OAuth token endpoint.
 */
interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token: string;
  expires_in?: number;
}

/**
 * Parse JWT claims from a token without signature verification.
 * Only used to extract metadata (account ID) -- not for auth decisions.
 */
function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = parts[1];
    // Convert base64url to base64, then decode
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const decoded = atob(padded);
    return JSON.parse(decoded);
  } catch {
    return undefined;
  }
}

/**
 * Extract the ChatGPT account ID from JWT claims.
 * Checks multiple claim locations (direct, nested, organization fallback).
 */
function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims['https://api.openai.com/auth']?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  );
}

/**
 * Extract account ID from token response, trying id_token first,
 * then falling back to access_token.
 */
function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token);
    if (claims) {
      const accountId = extractAccountIdFromClaims(claims);
      if (accountId) return accountId;
    }
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token);
    if (claims) {
      return extractAccountIdFromClaims(claims);
    }
  }
  return undefined;
}

/**
 * Convert a TokenResponse into an OAuthResult.
 */
function tokenResponseToResult(tokens: TokenResponse): OAuthResult {
  const accountId = extractAccountId(tokens);
  const expiresIn = tokens.expires_in ?? 3600;

  const result: OAuthResult = {
    apiKey: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  const metadata: Record<string, string> = {};
  if (accountId) {
    metadata.accountId = accountId;
  }
  if (tokens.id_token) {
    metadata.idToken = tokens.id_token;
  }
  if (Object.keys(metadata).length > 0) {
    result.metadata = metadata;
  }

  return result;
}

export class OpenAICodexOAuthProvider implements IOAuthProvider {
  readonly config: OAuthProviderConfig = {
    providerId: 'openai-codex',
    displayName: 'ChatGPT (Experimental)',
    authUrl: AUTH_ENDPOINT,
    tokenUrl: TOKEN_ENDPOINT,
    preferredPort: 1455,
    callbackPath: '/auth/callback',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    tokenType: 'expiring-token',
    clientId: CLIENT_ID,
    experimental: true,
    experimentalWarning:
      'This uses an unofficial API that may break without notice. ' +
      'Uses your ChatGPT Plus/Pro subscription. ' +
      'OAuth tokens will be stored in plugin settings.',
  };

  /**
   * Build the OpenAI Codex authorization URL.
   *
   * Includes all parameters from the validated spike: client_id,
   * response_type=code, redirect_uri, scope, state, code_challenge,
   * code_challenge_method=S256, prompt=login, and Codex-specific flags.
   */
  buildAuthUrl(
    callbackUrl: string,
    codeChallenge: string,
    state: string
  ): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: callbackUrl,
      scope: 'openid profile email offline_access',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      prompt: 'login',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'claudesidian',
    });

    return `${AUTH_ENDPOINT}?${params.toString()}`;
  }

  /**
   * Exchange the authorization code for tokens.
   *
   * POST form-urlencoded to the token endpoint with grant_type,
   * client_id, code, redirect_uri, and code_verifier. Returns
   * access_token, refresh_token, id_token, and expires_in.
   */
  async exchangeCode(
    code: string,
    codeVerifier: string,
    callbackUrl: string
  ): Promise<OAuthResult> {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        redirect_uri: callbackUrl,
        code_verifier: codeVerifier,
      }).toString(),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Codex token exchange failed: HTTP ${response.status} - ${body}`
      );
    }

    const tokens: TokenResponse = await response.json();
    return tokenResponseToResult(tokens);
  }

  /**
   * Refresh an expired access token.
   *
   * POST form-urlencoded with grant_type=refresh_token. Returns a new
   * set of tokens (including a new refresh_token -- token rotation).
   * Returns null if refresh fails (user must re-authenticate).
   */
  async refreshToken(refreshToken: string): Promise<OAuthResult | null> {
    try {
      const response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: CLIENT_ID,
          refresh_token: refreshToken,
        }).toString(),
      });

      if (!response.ok) {
        // Refresh failed -- user must re-authenticate
        return null;
      }

      const tokens: TokenResponse = await response.json();
      return tokenResponseToResult(tokens);
    } catch {
      // Network error or other failure -- user must re-authenticate
      return null;
    }
  }
}
