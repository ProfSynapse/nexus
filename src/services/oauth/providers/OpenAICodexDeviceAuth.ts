/**
 * OpenAI Codex device-code login for mobile Obsidian.
 * Follows the public Codex CLI device authorization protocol.
 * No Node.js, Electron, localhost listener or client secret required.
 */
import { ProviderHttpClient } from '../../llm/adapters/shared/ProviderHttpClient';
import { OpenAICodexOAuthProvider } from './OpenAICodexOAuthProvider';
import type { OAuthResult } from '../IOAuthProvider';

const ISSUER = 'https://auth.openai.com';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const MAX_WAIT_MS = 15 * 60 * 1000;

interface DeviceStart {
  device_auth_id: string;
  user_code: string;
  interval: string | number;
}

interface DeviceApproval {
  authorization_code: string;
  code_verifier: string;
  code_challenge: string;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

export class OpenAICodexDeviceAuth {
  async start(
    onDeviceCode: (userCode: string, verificationUrl: string) => void,
  ): Promise<OAuthResult> {
    const start = await ProviderHttpClient.request<DeviceStart>({
      url: `${ISSUER}/api/accounts/deviceauth/usercode`,
      provider: 'openai-codex',
      operation: 'Codex device authorization',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    });
    ProviderHttpClient.assertOk(start, 'Could not start Codex device login');
    const data = start.json;
    if (!data?.device_auth_id || !data.user_code) {
      throw new Error('Codex device authorization returned an invalid response');
    }
    const intervalSeconds = Number(data.interval);
    const intervalMs = Number.isFinite(intervalSeconds)
      ? Math.max(1000, Math.min(30000, intervalSeconds * 1000))
      : 5000;
    onDeviceCode(data.user_code, `${ISSUER}/codex/device`);

    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      await delay(intervalMs);
      const response = await ProviderHttpClient.request<DeviceApproval>({
        url: `${ISSUER}/api/accounts/deviceauth/token`,
        provider: 'openai-codex',
        operation: 'Codex device authorization polling',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_auth_id: data.device_auth_id,
          user_code: data.user_code,
        }),
      });
      // The official Codex CLI treats 403 and 404 as pending authorization.
      if (response.status === 403 || response.status === 404) continue;
      ProviderHttpClient.assertOk(response, 'Codex device authorization failed');
      const approval = response.json;
      if (!approval?.authorization_code || !approval.code_verifier || !approval.code_challenge) {
        throw new Error('Codex device authorization returned an invalid approval');
      }
      return new OpenAICodexOAuthProvider().exchangeCode(
        approval.authorization_code,
        approval.code_verifier,
        `${ISSUER}/deviceauth/callback`,
      );
    }
    throw new Error('Codex device login timed out after 15 minutes');
  }
}
