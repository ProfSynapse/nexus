/**
 * SecretStore.ts
 * Location: src/services/secrets/SecretStore.ts
 *
 * Thin, throw-safe wrapper over Obsidian's first-party `app.secretStorage`
 * (available since Obsidian 1.11.4). Secrets stored here are device-local and
 * OS-encrypted; they are NOT written to the synced `data.json`.
 *
 * Used by: src/settings.ts to strip plaintext secrets out of persisted
 * settings on save and hydrate them back into the in-memory settings on load.
 *
 * The secretStorage API is synchronous and has NO removeSecret — "clearing" a
 * secret means setting it to the empty string. If the API is unavailable
 * (older Obsidian) or a write throws, callers fall back to plaintext persist
 * so a user's key is never lost.
 */

/**
 * Structural shape of `app.secretStorage`. Declared locally so the wrapper does
 * not depend on the SecretStorage class being present in every typings build.
 */
export interface SecretStorageApi {
  setSecret(id: string, secret: string): void;
  getSecret(id: string): string | null;
  listSecrets(): string[];
}

/**
 * Minimal app shape needed to reach `secretStorage`. The property is optional
 * because it is absent on Obsidian < 1.11.4.
 */
export interface SecretStorageHost {
  secretStorage?: SecretStorageApi;
}

/** Prefix for every secret id Nexus owns, to avoid collisions with other plugins. */
const ID_PREFIX = 'nexus';

/**
 * Normalize an arbitrary identifier fragment to the secretStorage id constraint
 * (lowercase alphanumeric with dashes). Runs of disallowed characters collapse
 * to a single dash; leading/trailing dashes are trimmed.
 */
export function normalizeSecretIdFragment(fragment: string): string {
  return fragment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Secret id for an LLM provider API key: `nexus-llm-<providerId>-apikey`. */
export function llmApiKeySecretId(providerId: string): string {
  return `${ID_PREFIX}-llm-${normalizeSecretIdFragment(providerId)}-apikey`;
}

/** Secret id for an LLM provider OAuth refresh token: `nexus-llm-<providerId>-oauth-refresh`. */
export function llmOAuthRefreshSecretId(providerId: string): string {
  return `${ID_PREFIX}-llm-${normalizeSecretIdFragment(providerId)}-oauth-refresh`;
}

/** Secret id for an app credential: `nexus-app-<appId>-<credKey>`. */
export function appCredentialSecretId(appId: string, credKey: string): string {
  return `${ID_PREFIX}-app-${normalizeSecretIdFragment(appId)}-${normalizeSecretIdFragment(credKey)}`;
}

/**
 * Throw-safe wrapper over `app.secretStorage`. Every method swallows errors and
 * reports failure via its return value so a misbehaving backend never breaks
 * settings persistence.
 */
export class SecretStore {
  private readonly host: SecretStorageHost;

  constructor(host: SecretStorageHost) {
    this.host = host;
  }

  /** True when `app.secretStorage` exists and exposes the expected methods. */
  isAvailable(): boolean {
    const api = this.host.secretStorage;
    return !!api
      && typeof api.setSecret === 'function'
      && typeof api.getSecret === 'function'
      && typeof api.listSecrets === 'function';
  }

  /**
   * Store a secret under `id`. Returns true on success, false if the store is
   * unavailable or the write throws (e.g. invalid id).
   */
  set(id: string, value: string): boolean {
    const api = this.host.secretStorage;
    if (!this.isAvailable() || !api) {
      return false;
    }
    try {
      api.setSecret(id, value);
      return true;
    } catch {
      return false;
    }
  }

  /** Read a secret, or null when missing/unavailable/throwing. */
  get(id: string): string | null {
    const api = this.host.secretStorage;
    if (!this.isAvailable() || !api) {
      return null;
    }
    try {
      return api.getSecret(id);
    } catch {
      return null;
    }
  }

  /** Clear a secret by setting it to the empty string (no removeSecret exists). */
  clear(id: string): boolean {
    return this.set(id, '');
  }
}
