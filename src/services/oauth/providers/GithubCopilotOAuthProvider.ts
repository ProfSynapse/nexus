/**
 * GithubCopilotOAuthProvider.ts
 * Location: src/services/oauth/providers/GithubCopilotOAuthProvider.ts
 *
 * OAuth provider for GitHub Copilot using the GitHub Device Flow (RFC 8628).
 * Unlike standard PKCE OAuth providers, Copilot uses device authorization:
 *   1. POST to /login/device/code → get device_code + user_code + verification_uri
 *   2. User opens verification_uri and enters user_code
 *   3. Poll /login/oauth/access_token with device_code until token granted
 *
 * The access token (ghu_*) is then used to obtain ephemeral Copilot session
 * tokens from api.github.com/copilot_internal/v2/token.
 *
 * Used by: ProvidersTab (startGithubCopilotDeviceFlow), AdapterRegistry
 */

import { Notice } from 'obsidian';
import { IOAuthProvider, OAuthProviderConfig, OAuthResult } from '../IOAuthProvider';
import { ProviderHttpClient } from '../../llm/adapters/shared/ProviderHttpClient';

/** GitHub's OAuth app client ID for Copilot Chat (VS Code extension) */
const COPILOT_CLIENT_ID = '01ab8ac9400c4e429b23';

/** Device authorization endpoint */
const DEVICE_CODE_URL = 'https://github.com/login/device/code';

/** Token exchange/polling endpoint */
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** Where the user enters their code */
const VERIFICATION_URL = 'https://github.com/login/device';

/** Default polling interval in ms (GitHub recommends at least 5s) */
const POLL_INTERVAL_MS = 5000;

/** Maximum time to wait for user to complete device flow (5 minutes) */
const MAX_POLL_DURATION_MS = 300000;

/**
 * Response from GitHub's device code endpoint
 */
interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

/**
 * Response from GitHub's token polling endpoint
 */
interface TokenPollResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

export class GithubCopilotOAuthProvider implements IOAuthProvider {
  config: OAuthProviderConfig = {
    providerId: 'github-copilot',
    displayName: 'GitHub Copilot',
    authUrl: DEVICE_CODE_URL,
    tokenUrl: TOKEN_URL,
    preferredPort: 0,
    callbackPath: '',
    scopes: ['read:user'],
    tokenType: 'permanent-key',
    clientId: COPILOT_CLIENT_ID,
    experimental: true,
    experimentalWarning: 'This connects via an undocumented GitHub Copilot proxy. Requires an active GitHub Copilot subscription.'
  };

  /**
   * Not used for device flow — the device flow does not open a browser auth URL.
   * Returns an empty string; the actual verification URL is opened by startDeviceFlow().
   */
  buildAuthUrl(_callbackUrl: string, _codeChallenge: string, _state: string): string {
    return '';
  }

  /**
   * Exchange a device_code for an access token by polling GitHub's token endpoint.
   * Called after the user has entered their user_code at the verification URL.
   *
   * @param code - The device_code from the device flow initiation
   */
  async exchangeCode(code: string, _codeVerifier: string, _callbackUrl: string): Promise<OAuthResult> {
    const startTime = Date.now();
    let pollInterval = POLL_INTERVAL_MS;

    while (Date.now() - startTime < MAX_POLL_DURATION_MS) {
      const response = await ProviderHttpClient.request({
        url: TOKEN_URL,
        provider: 'github-copilot',
        operation: 'pollDeviceToken',
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          client_id: COPILOT_CLIENT_ID,
          device_code: code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        })
      });

      const res = response.json as TokenPollResponse | null;
      if (!res) {
        throw new Error('Empty response from GitHub token endpoint');
      }

      if (res.access_token) {
        return { apiKey: res.access_token };
      }

      if (res.error === 'authorization_pending') {
        // User hasn't completed flow yet — wait and retry
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        continue;
      }

      if (res.error === 'slow_down') {
        // GitHub is asking us to increase the polling interval
        pollInterval = (res.interval ?? 10) * 1000;
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        continue;
      }

      if (res.error === 'expired_token') {
        throw new Error('Device code expired. Please try connecting again.');
      }

      if (res.error === 'access_denied') {
        throw new Error('Authorization was denied. Please try again.');
      }

      // Unknown error
      throw new Error(res.error_description || res.error || 'Device flow token exchange failed');
    }

    throw new Error('Device login timed out. Please try connecting again.');
  }

  /**
   * Start the full GitHub device authorization flow.
   *
   * This method is called directly by ProvidersTab (bypassing OAuthService.startFlow(),
   * which assumes a redirect-based PKCE flow). It:
   *   1. Requests a device_code + user_code from GitHub
   *   2. Opens the verification URL in the user's browser
   *   3. Shows the user_code via Obsidian Notice so the user can enter it
   *   4. Polls for the access token
   *
   * @returns OAuthResult with the GitHub OAuth token (ghu_*)
   */
  async startDeviceFlow(onCode?: (userCode: string, verificationUri: string) => void): Promise<OAuthResult> {
    // Step 1: Request device code
    const deviceResponse = await ProviderHttpClient.request({
      url: DEVICE_CODE_URL,
      provider: 'github-copilot',
      operation: 'requestDeviceCode',
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID,
        scope: this.config.scopes.join(' ')
      })
    });

    const deviceData = deviceResponse.json as DeviceCodeResponse | null;
    if (!deviceData?.device_code || !deviceData?.user_code) {
      throw new Error('Failed to initialize GitHub device flow — no device code returned');
    }

    // Step 2: Open verification URL in browser
    try {
      const { shell } = require('electron');
      shell.openExternal(deviceData.verification_uri || VERIFICATION_URL);
    } catch {
      window.open(deviceData.verification_uri || VERIFICATION_URL, '_blank');
    }

    // Step 3: Show user_code — prefer inline callback, fallback to Notice
    if (onCode) {
      onCode(deviceData.user_code, deviceData.verification_uri || VERIFICATION_URL);
    } else {
      new Notice(
        `GitHub Copilot: Enter code ${deviceData.user_code} in your browser to complete sign-in.`,
        30000
      );
    }

    // Step 4: Poll for token using exchangeCode
    return this.exchangeCode(deviceData.device_code, '', '');
  }
}
