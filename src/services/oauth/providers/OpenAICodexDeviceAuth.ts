/**
 * OpenAI Codex device-code login for mobile Obsidian.
 * Follows the public Codex CLI device authorization protocol.
 * No Node.js, Electron, localhost listener or client secret required.
 */
import { ProviderHttpClient } from '../../llm/adapters/shared/ProviderHttpClient';
import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_ISSUER,
  OpenAICodexOAuthProvider,
} from './OpenAICodexOAuthProvider';
import type { OAuthResult } from '../IOAuthProvider';
import { abortableDelay, throwIfAborted } from '../DeviceFlowCancellation';

const ISSUER = CODEX_OAUTH_ISSUER;
const MAX_WAIT_MS = 15 * 60 * 1000;
const CANCELLED = 'Codex device login cancelled';

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

export class OpenAICodexDeviceAuth {
  async start(
    onDeviceCode: (userCode: string, verificationUrl: string) => void,
    signal?: AbortSignal,
  ): Promise<OAuthResult> {
    throwIfAborted(signal, CANCELLED);
    const start = await ProviderHttpClient.request<DeviceStart>({
      url: `${ISSUER}/api/accounts/deviceauth/usercode`,
      provider: 'openai-codex',
      operation: 'Codex device authorization',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
      signal,
    });
    if (!start.ok) {
      throw new Error(
        `Could not start Codex device login (HTTP ${start.status}). `
        + 'If device code sign-in is turned off for your ChatGPT account, enable it in ChatGPT security settings and try again.'
      );
    }
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
      await abortableDelay(intervalMs, signal);
      throwIfAborted(signal, CANCELLED);
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
        signal,
      });
      throwIfAborted(signal, CANCELLED);
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
