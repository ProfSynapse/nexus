/**
 * SettingsSecrets.ts
 * Location: src/services/secrets/SettingsSecrets.ts
 *
 * The persistence boundary that moves plaintext secrets out of the synced
 * `data.json` and into `app.secretStorage`. The in-memory settings shape is
 * unchanged: every secret field stays a populated string at runtime so all
 * existing readers (adapters, ProviderManager, UI) keep working untouched.
 *
 * Used by: src/settings.ts.
 *
 * Three operations, all keyed off the same field enumeration:
 *   - hydrateSecrets(settings):  load → fill each secret field from secretStorage
 *   - stripSecretsForPersist(settings): save → write each secret to secretStorage
 *                                        and return a clone with the field blanked
 *   - migrateLegacyPlaintext(settings): on load, move any plaintext secret still
 *                                        in data.json into secretStorage (idempotent)
 *
 * When secretStorage is unavailable, hydrate/strip become no-ops and the caller
 * persists plaintext exactly as before (no behavior change on Obsidian < 1.11.4).
 */

import type { MCPSettings } from '../../types';
import type { LLMProviderConfig } from '../../types/llm/ProviderTypes';
import type { AppConfig } from '../../types/apps/AppTypes';
import {
  SecretStore,
  appCredentialSecretId,
  llmApiKeySecretId,
  llmOAuthRefreshSecretId
} from './SecretStore';

/**
 * One secret field located within a settings object: a stable secretStorage id
 * plus get/set accessors that read and write the in-memory value at that path.
 */
interface SecretFieldRef {
  id: string;
  read(): string | undefined;
  write(value: string): void;
}

function providerEntries(settings: MCPSettings): Array<[string, LLMProviderConfig]> {
  const providers = settings.llmProviders?.providers;
  if (!providers || typeof providers !== 'object') {
    return [];
  }
  return Object.entries(providers);
}

function appEntries(settings: MCPSettings): Array<[string, AppConfig]> {
  const apps = settings.apps?.apps;
  if (!apps || typeof apps !== 'object') {
    return [];
  }
  return Object.entries(apps);
}

/**
 * Enumerate every secret-bearing field on the settings object. Each ref's
 * read/write operate directly on the passed-in object's nested structures, so
 * writing through them mutates the same in-memory settings.
 */
function collectSecretFields(settings: MCPSettings): SecretFieldRef[] {
  const refs: SecretFieldRef[] = [];

  for (const [providerId, config] of providerEntries(settings)) {
    refs.push({
      id: llmApiKeySecretId(providerId),
      read: () => config.apiKey,
      write: (value) => { config.apiKey = value; }
    });
    if (config.oauth) {
      const oauth = config.oauth;
      refs.push({
        id: llmOAuthRefreshSecretId(providerId),
        read: () => oauth.refreshToken,
        write: (value) => { oauth.refreshToken = value; }
      });
    }
  }

  for (const [appId, config] of appEntries(settings)) {
    const credentials = config.credentials;
    if (!credentials || typeof credentials !== 'object') {
      continue;
    }
    for (const credKey of Object.keys(credentials)) {
      refs.push({
        id: appCredentialSecretId(appId, credKey),
        read: () => credentials[credKey],
        write: (value) => { credentials[credKey] = value; }
      });
    }
  }

  return refs;
}

/**
 * Load each secret field's value from secretStorage onto the in-memory settings
 * object. No-op when secretStorage is unavailable. Only overwrites a field when
 * a non-null secret exists, so a freshly hydrated value never clobbers a
 * runtime-set one that hasn't been persisted yet.
 */
export function hydrateSecrets(settings: MCPSettings, store: SecretStore): void {
  if (!store.isAvailable()) {
    return;
  }
  for (const field of collectSecretFields(settings)) {
    const stored = store.get(field.id);
    if (stored !== null && stored !== '') {
      field.write(stored);
    }
  }
}

/**
 * Produce a structurally-cloned copy of `settings` with every secret field
 * blanked, after writing each secret value to secretStorage. The original
 * in-memory `settings` is left untouched (runtime keeps its populated values).
 *
 * Returns `{ settings, persisted }`. When `persisted` is false the store was
 * unavailable (or every write failed) and the caller should persist the
 * original plaintext settings so no key is lost.
 */
export function stripSecretsForPersist(
  settings: MCPSettings,
  store: SecretStore
): { settings: MCPSettings; persisted: boolean } {
  if (!store.isAvailable()) {
    return { settings, persisted: false };
  }

  const clone = structuredCloneSettings(settings);
  const fields = collectSecretFields(clone);
  let anyPersisted = false;
  let anyFailed = false;

  for (const field of fields) {
    const value = field.read();
    if (value === undefined) {
      continue;
    }
    if (value === '') {
      field.write('');
      continue;
    }
    const ok = store.set(field.id, value);
    if (ok) {
      anyPersisted = true;
      field.write('');
    } else {
      anyFailed = true;
    }
  }

  if (anyFailed && !anyPersisted) {
    return { settings, persisted: false };
  }
  return { settings: clone, persisted: true };
}

/**
 * Move any plaintext secret still present on the in-memory settings into
 * secretStorage. Idempotent: safe to call on every load. Returns true if at
 * least one secret was migrated (signaling the caller to re-save so the
 * plaintext is stripped from data.json). No-op when unavailable.
 */
export function migrateLegacyPlaintext(settings: MCPSettings, store: SecretStore): boolean {
  if (!store.isAvailable()) {
    return false;
  }
  let migrated = false;
  for (const field of collectSecretFields(settings)) {
    const value = field.read();
    if (value === undefined || value === '') {
      continue;
    }
    if (store.set(field.id, value)) {
      migrated = true;
    }
  }
  return migrated;
}

/**
 * Clone the settings object deeply enough that mutating secret fields on the
 * copy does not touch the original's nested provider/app structures. Settings
 * are plain JSON-serializable data, so a JSON round-trip is sufficient and
 * cross-platform.
 */
function structuredCloneSettings(settings: MCPSettings): MCPSettings {
  return JSON.parse(JSON.stringify(settings)) as MCPSettings;
}
