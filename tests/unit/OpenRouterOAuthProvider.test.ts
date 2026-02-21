/**
 * OpenRouterOAuthProvider Unit Tests
 *
 * Tests the OpenRouter OAuth provider:
 * - Static configuration (provider ID, port, etc.)
 * - Authorization URL construction
 * - Token exchange via mocked fetch
 * - Pre-auth parameter handling
 */

import { OpenRouterOAuthProvider } from '../../src/services/oauth/providers/OpenRouterOAuthProvider';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('OpenRouterOAuthProvider', () => {
  let provider: OpenRouterOAuthProvider;

  beforeEach(() => {
    provider = new OpenRouterOAuthProvider();
    jest.clearAllMocks();
  });

  describe('config', () => {
    it('should have providerId "openrouter"', () => {
      expect(provider.config.providerId).toBe('openrouter');
    });

    it('should have displayName "OpenRouter"', () => {
      expect(provider.config.displayName).toBe('OpenRouter');
    });

    it('should prefer port 3000', () => {
      expect(provider.config.preferredPort).toBe(3000);
    });

    it('should use /callback path', () => {
      expect(provider.config.callbackPath).toBe('/callback');
    });

    it('should have empty scopes', () => {
      expect(provider.config.scopes).toEqual([]);
    });

    it('should use permanent-key token type', () => {
      expect(provider.config.tokenType).toBe('permanent-key');
    });

    it('should have empty clientId', () => {
      expect(provider.config.clientId).toBe('');
    });

    it('should not be marked experimental', () => {
      expect(provider.config.experimental).toBeUndefined();
    });

    it('should point to correct auth URL', () => {
      expect(provider.config.authUrl).toBe('https://openrouter.ai/auth');
    });

    it('should point to correct token URL', () => {
      expect(provider.config.tokenUrl).toBe('https://openrouter.ai/api/v1/auth/keys');
    });
  });

  describe('buildAuthUrl', () => {
    const callbackUrl = 'http://127.0.0.1:3000/callback';
    const codeChallenge = 'test-challenge-abc123';
    const state = 'test-state-xyz';

    it('should produce a URL starting with the auth endpoint', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state);
      expect(url).toMatch(/^https:\/\/openrouter\.ai\/auth\?/);
    });

    it('should include callback_url parameter', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state);
      const params = new URL(url).searchParams;
      expect(params.get('callback_url')).toBe(callbackUrl);
    });

    it('should include code_challenge parameter', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state);
      const params = new URL(url).searchParams;
      expect(params.get('code_challenge')).toBe(codeChallenge);
    });

    it('should include code_challenge_method=S256', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state);
      const params = new URL(url).searchParams;
      expect(params.get('code_challenge_method')).toBe('S256');
    });

    it('should include state parameter', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state);
      const params = new URL(url).searchParams;
      expect(params.get('state')).toBe(state);
    });

    it('should include key_label when provided in preAuthParams', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state, {
        key_label: 'My Obsidian Key',
      });
      const params = new URL(url).searchParams;
      expect(params.get('key_label')).toBe('My Obsidian Key');
    });

    it('should include credit_limit as "limit" parameter', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state, {
        credit_limit: '10',
      });
      const params = new URL(url).searchParams;
      expect(params.get('limit')).toBe('10');
    });

    it('should not include key_label when not provided', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state);
      const params = new URL(url).searchParams;
      expect(params.has('key_label')).toBe(false);
    });

    it('should not include limit when credit_limit not provided', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state);
      const params = new URL(url).searchParams;
      expect(params.has('limit')).toBe(false);
    });

    it('should not include key_label when it is empty string', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state, {
        key_label: '',
      });
      const params = new URL(url).searchParams;
      expect(params.has('key_label')).toBe(false);
    });

    it('should include both key_label and limit when both provided', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state, {
        key_label: 'MyKey',
        credit_limit: '5',
      });
      const params = new URL(url).searchParams;
      expect(params.get('key_label')).toBe('MyKey');
      expect(params.get('limit')).toBe('5');
    });
  });

  describe('exchangeCode', () => {
    it('should POST to token URL with correct JSON body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ key: 'sk-or-v1-test-key' }),
      });

      await provider.exchangeCode('auth-code-123', 'verifier-abc', 'http://127.0.0.1:3000/callback');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://openrouter.ai/api/v1/auth/keys',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.code).toBe('auth-code-123');
      expect(body.code_verifier).toBe('verifier-abc');
      expect(body.code_challenge_method).toBe('S256');
    });

    it('should return OAuthResult with the API key', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ key: 'sk-or-v1-my-key' }),
      });

      const result = await provider.exchangeCode('code', 'verifier', 'http://localhost:3000/callback');

      expect(result.apiKey).toBe('sk-or-v1-my-key');
      // Permanent key -- no refresh token or expiry
      expect(result.refreshToken).toBeUndefined();
      expect(result.expiresAt).toBeUndefined();
    });

    it('should throw on HTTP error response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Invalid code',
      });

      await expect(
        provider.exchangeCode('bad-code', 'verifier', 'http://localhost:3000/callback')
      ).rejects.toThrow('OpenRouter token exchange failed: HTTP 400 - Invalid code');
    });

    it('should throw when response has no key', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });

      await expect(
        provider.exchangeCode('code', 'verifier', 'http://localhost:3000/callback')
      ).rejects.toThrow('OpenRouter token exchange returned no key');
    });

    it('should throw when response key is empty string', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ key: '' }),
      });

      await expect(
        provider.exchangeCode('code', 'verifier', 'http://localhost:3000/callback')
      ).rejects.toThrow('OpenRouter token exchange returned no key');
    });
  });

  describe('refreshToken', () => {
    it('should not have a refreshToken method (permanent keys)', () => {
      expect((provider as any).refreshToken).toBeUndefined();
    });
  });
});
