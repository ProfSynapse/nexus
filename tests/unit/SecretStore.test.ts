import {
  SecretStore,
  normalizeSecretIdFragment,
  llmApiKeySecretId,
  llmOAuthRefreshSecretId,
  appCredentialSecretId,
  type SecretStorageApi,
  type SecretStorageHost
} from '../../src/services/secrets/SecretStore';

/** In-memory stand-in for app.secretStorage with the same synchronous contract. */
function createMockSecretStorage(overrides: Partial<SecretStorageApi> = {}): {
  api: SecretStorageApi;
  map: Map<string, string>;
} {
  const map = new Map<string, string>();
  const api: SecretStorageApi = {
    setSecret(id: string, secret: string): void {
      if (!/^[a-z0-9-]+$/.test(id)) {
        throw new Error(`invalid id: ${id}`);
      }
      map.set(id, secret);
    },
    getSecret(id: string): string | null {
      return map.has(id) ? (map.get(id) as string) : null;
    },
    listSecrets(): string[] {
      return [...map.keys()];
    },
    ...overrides
  };
  return { api, map };
}

describe('SecretStore id derivation', () => {
  it('normalizes fragments to lowercase-alphanumeric-dashes', () => {
    expect(normalizeSecretIdFragment('OpenAI')).toBe('openai');
    expect(normalizeSecretIdFragment('github-copilot')).toBe('github-copilot');
    expect(normalizeSecretIdFragment('foo_bar.baz')).toBe('foo-bar-baz');
    expect(normalizeSecretIdFragment('  --Weird  Key!! ')).toBe('weird-key');
  });

  it('builds stable provider and app secret ids', () => {
    expect(llmApiKeySecretId('openai')).toBe('nexus-llm-openai-apikey');
    expect(llmApiKeySecretId('github-copilot')).toBe('nexus-llm-github-copilot-apikey');
    expect(llmOAuthRefreshSecretId('openrouter')).toBe('nexus-llm-openrouter-oauth-refresh');
    expect(appCredentialSecretId('elevenlabs', 'apiKey')).toBe('nexus-app-elevenlabs-apikey');
  });

  it('produces ids that satisfy the secretStorage id constraint', () => {
    const ids = [
      llmApiKeySecretId('anthropic-claude-code'),
      llmOAuthRefreshSecretId('openai-codex'),
      appCredentialSecretId('My App', 'webhook URL')
    ];
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe('SecretStore get/set/clear', () => {
  it('reports availability based on the host API', () => {
    const { api } = createMockSecretStorage();
    expect(new SecretStore({ secretStorage: api }).isAvailable()).toBe(true);
    expect(new SecretStore({}).isAvailable()).toBe(false);
    expect(new SecretStore({ secretStorage: {} as SecretStorageApi }).isAvailable()).toBe(false);
  });

  it('round-trips set and get', () => {
    const { api, map } = createMockSecretStorage();
    const store = new SecretStore({ secretStorage: api });
    expect(store.set('nexus-llm-openai-apikey', 'sk-123')).toBe(true);
    expect(map.get('nexus-llm-openai-apikey')).toBe('sk-123');
    expect(store.get('nexus-llm-openai-apikey')).toBe('sk-123');
  });

  it('returns null for missing keys and on unavailable store', () => {
    const { api } = createMockSecretStorage();
    expect(new SecretStore({ secretStorage: api }).get('absent')).toBeNull();
    expect(new SecretStore({}).get('nexus-llm-openai-apikey')).toBeNull();
  });

  it('clear sets the empty string (no removeSecret exists)', () => {
    const { api, map } = createMockSecretStorage();
    const store = new SecretStore({ secretStorage: api });
    store.set('nexus-app-x-apikey', 'value');
    expect(store.clear('nexus-app-x-apikey')).toBe(true);
    expect(map.get('nexus-app-x-apikey')).toBe('');
  });

  it('is throw-safe: a failing setSecret reports false, not an exception', () => {
    const { api } = createMockSecretStorage({
      setSecret() { throw new Error('boom'); }
    });
    const store = new SecretStore({ secretStorage: api } as SecretStorageHost);
    expect(() => store.set('nexus-llm-openai-apikey', 'sk')).not.toThrow();
    expect(store.set('nexus-llm-openai-apikey', 'sk')).toBe(false);
  });

  it('is throw-safe: invalid id rejected by backend yields false', () => {
    const { api } = createMockSecretStorage();
    const store = new SecretStore({ secretStorage: api });
    expect(store.set('NOT VALID', 'x')).toBe(false);
  });
});
