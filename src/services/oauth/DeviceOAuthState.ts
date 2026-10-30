/**
 * DeviceOAuthState.ts
 * Location: src/services/oauth/DeviceOAuthState.ts
 *
 * Connection state for OAuth providers whose tokens live in this device's
 * secret storage. The `oauth` flags (connected, expiresAt, accountId) sync
 * through data.json, but the access and refresh tokens do not, so "connected"
 * has to be judged per device: a synced `connected: true` with no local token
 * means the account was signed in on another device, not this one.
 *
 * Used by: GenericProviderModal (banner), ProvidersTab (provider card),
 * SettingsSecrets (clearing emptied tokens).
 */

import type { LLMProviderConfig } from '../../types/llm/ProviderTypes';

/** Providers whose OAuth tokens are stored per device rather than synced. */
const DEVICE_TOKEN_OAUTH_PROVIDERS: ReadonlySet<string> = new Set(['openai-codex', 'github-copilot']);

/** Whether this provider kind keeps its OAuth tokens on each device. */
export function usesDeviceOAuthTokens(providerKind: string | undefined): boolean {
  return !!providerKind && DEVICE_TOKEN_OAUTH_PROVIDERS.has(providerKind);
}

export interface DeviceOAuthState {
  /** Signed in and holding a token on this device. */
  connected: boolean;
  /** The banner should offer to reconnect rather than a first connect. */
  reconnectRequired: boolean;
  /** Signed in somewhere, but not on this device. */
  missingOnThisDevice: boolean;
}

export function getDeviceOAuthState(
  providerKind: string | undefined,
  config: Pick<LLMProviderConfig, 'apiKey' | 'oauth'>,
): DeviceOAuthState {
  const syncedConnected = !!config.oauth?.connected;
  const legacyReconnect = !!config.oauth?.reconnectRequired;
  if (!usesDeviceOAuthTokens(providerKind)) {
    return { connected: syncedConnected, reconnectRequired: legacyReconnect, missingOnThisDevice: false };
  }
  const hasLocalToken = !!config.apiKey;
  const missingOnThisDevice = syncedConnected && !hasLocalToken;
  return {
    connected: syncedConnected && hasLocalToken,
    reconnectRequired: legacyReconnect || missingOnThisDevice,
    missingOnThisDevice,
  };
}
