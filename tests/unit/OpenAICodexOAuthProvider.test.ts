/**
 * OpenAICodexOAuthProvider Unit Tests
 *
 * Tests the OpenAI Codex OAuth provider:
 * - Static configuration
 * - Authorization URL construction
 * - Token exchange (form-urlencoded)
 * - JWT parsing for account ID extraction
 * - Token refresh
 */

import { OpenAICodexOAuthProvider } from '../../src/services/oauth/providers/OpenAICodexOAuthProvider';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

/** Helper: create a mock JWT with given claims payload */
function createMockJwt(claims: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  const signature = 'mock-signature';
  return `${header}.${payload}.${signature}`;
}

describe('OpenAICodexOAuthProvider', () => {
  let provider: OpenAICodexOAuthProvider;

  beforeEach(() => {
    provider = new OpenAICodexOAuthProvider();
    jest.clearAllMocks();
  });

  describe('config', () => {
    it('should have providerId "openai-codex"', () => {
      expect(provider.config.providerId).toBe('openai-codex');
    });

    it('should have correct client_id', () => {
      expect(provider.config.clientId).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    });

    it('should prefer port 1455', () => {
      expect(provider.config.preferredPort).toBe(1455);
    });

    it('should use /auth/callback path', () => {
      expect(provider.config.callbackPath).toBe('/auth/callback');
    });

    it('should request openid, profile, email, offline_access scopes', () => {
      expect(provider.config.scopes).toEqual(['openid', 'profile', 'email', 'offline_access']);
    });

    it('should use expiring-token type', () => {
      expect(provider.config.tokenType).toBe('expiring-token');
    });

    it('should display name "ChatGPT"', () => {
      expect(provider.config.displayName).toBe('ChatGPT');
    });

    it('should point to correct auth endpoint', () => {
      expect(provider.config.authUrl).toBe('https://auth.openai.com/oauth/authorize');
    });

    it('should point to correct token endpoint', () => {
      expect(provider.config.tokenUrl).toBe('https://auth.openai.com/oauth/token');
    });
  });

  describe('buildAuthUrl', () => {
    const callbackUrl = 'http://127.0.0.1:1455/auth/callback';
    const codeChallenge = 'test-challenge';
    const state = 'test-state';

    it('should produce a URL starting with the auth endpoint', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state);
      expect(url).toMatch(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
    });

    it('should include response_type=code', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state);
      const params = new URL(url).searchParams;
      expect(params.get('response_type')).toBe('code');
    });

    it('should include the correct client_id', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state);
      const params = new URL(url).searchParams;
      expect(params.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    });

    it('should include redirect_uri', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state);
      const params = new URL(url).searchParams;
      expect(params.get('redirect_uri')).toBe(callbackUrl);
    });

    it('should include correct scope', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state);
      const params = new URL(url).searchParams;
      expect(params.get('scope')).toBe('openid profile email offline_access');
    });

    it('should include code_challenge and code_challenge_method=S256', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state);
      const params = new URL(url).searchParams;
      expect(params.get('code_challenge')).toBe(codeChallenge);
      expect(params.get('code_challenge_method')).toBe('S256');
    });

    it('should include state parameter', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state);
      const params = new URL(url).searchParams;
      expect(params.get('state')).toBe(state);
    });

    it('should include prompt=login', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state);
      const params = new URL(url).searchParams;
      expect(params.get('prompt')).toBe('login');
    });

    it('should include codex_cli_simplified_flow=true', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state);
      const params = new URL(url).searchParams;
      expect(params.get('codex_cli_simplified_flow')).toBe('true');
    });

    it('should include id_token_add_organizations=true', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state);
      const params = new URL(url).searchParams;
      expect(params.get('id_token_add_organizations')).toBe('true');
    });

    it('should include originator=opencode', () => {
      const url = provider.buildAuthUrl(callbackUrl, codeChallenge, state);
      const params = new URL(url).searchParams;
      expect(params.get('originator')).toBe('opencode');
    });
  });

  describe('exchangeCode', () => {
    const callbackUrl = 'http://127.0.0.1:1455/auth/callback';

    it('should POST form-urlencoded to token endpoint', async () => {
      const idToken = createMockJwt({ chatgpt_account_id: 'acct-123' });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'at-xyz',
          refresh_token: 'rt-abc',
          id_token: idToken,
          expires_in: 3600,
        }),
      });

      await provider.exchangeCode('auth-code', 'verifier-123', callbackUrl);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://auth.openai.com/oauth/token',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
      );

      const body = new URLSearchParams(mockFetch.mock.calls[0][1].body);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
      expect(body.get('code')).toBe('auth-code');
      expect(body.get('redirect_uri')).toBe(callbackUrl);
      expect(body.get('code_verifier')).toBe('verifier-123');
    });

    it('should return OAuthResult with access_token as apiKey', async () => {
      const idToken = createMockJwt({ chatgpt_account_id: 'acct-456' });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'at-my-token',
          refresh_token: 'rt-my-refresh',
          id_token: idToken,
          expires_in: 7200,
        }),
      });

      const result = await provider.exchangeCode('code', 'verifier', callbackUrl);

      expect(result.apiKey).toBe('at-my-token');
      expect(result.refreshToken).toBe('rt-my-refresh');
      expect(result.expiresAt).toBeGreaterThan(Date.now());
    });

    it('should extract accountId from id_token chatgpt_account_id claim', async () => {
      const idToken = createMockJwt({ chatgpt_account_id: 'acct-from-id-token' });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'at-1',
          refresh_token: 'rt-1',
          id_token: idToken,
          expires_in: 3600,
        }),
      });

      const result = await provider.exchangeCode('code', 'verifier', callbackUrl);

      expect(result.metadata?.accountId).toBe('acct-from-id-token');
    });

    it('should extract accountId from nested auth claim', async () => {
      const idToken = createMockJwt({
        'https://api.openai.com/auth': { chatgpt_account_id: 'nested-acct-id' },
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'at-2',
          refresh_token: 'rt-2',
          id_token: idToken,
          expires_in: 3600,
        }),
      });

      const result = await provider.exchangeCode('code', 'verifier', callbackUrl);

      expect(result.metadata?.accountId).toBe('nested-acct-id');
    });

    it('should fall back to organizations[0].id for accountId', async () => {
      const idToken = createMockJwt({
        organizations: [{ id: 'org-abc-123' }],
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'at-3',
          refresh_token: 'rt-3',
          id_token: idToken,
          expires_in: 3600,
        }),
      });

      const result = await provider.exchangeCode('code', 'verifier', callbackUrl);

      expect(result.metadata?.accountId).toBe('org-abc-123');
    });

    it('should fall back to access_token for accountId when id_token has no account info', async () => {
      const idTokenWithoutAccount = createMockJwt({ email: 'user@example.com' });
      const accessTokenWithAccount = createMockJwt({ chatgpt_account_id: 'acct-from-at' });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: accessTokenWithAccount,
          refresh_token: 'rt-4',
          id_token: idTokenWithoutAccount,
          expires_in: 3600,
        }),
      });

      const result = await provider.exchangeCode('code', 'verifier', callbackUrl);

      expect(result.metadata?.accountId).toBe('acct-from-at');
    });

    it('should NOT include idToken in metadata (PII prevention)', async () => {
      const idToken = createMockJwt({ chatgpt_account_id: 'acct-x' });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'at-5',
          refresh_token: 'rt-5',
          id_token: idToken,
          expires_in: 3600,
        }),
      });

      const result = await provider.exchangeCode('code', 'verifier', callbackUrl);

      // id_token contains email PII and must NOT be persisted in metadata
      expect(result.metadata?.idToken).toBeUndefined();
      // accountId should still be extracted
      expect(result.metadata?.accountId).toBe('acct-x');
    });

    it('should default expires_in to 3600 when not provided', async () => {
      const idToken = createMockJwt({});
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'at-6',
          refresh_token: 'rt-6',
          id_token: idToken,
          // No expires_in
        }),
      });

      const beforeTime = Date.now();
      const result = await provider.exchangeCode('code', 'verifier', callbackUrl);
      const afterTime = Date.now();

      // Should default to 3600 seconds (1 hour)
      expect(result.expiresAt).toBeGreaterThanOrEqual(beforeTime + 3600 * 1000);
      expect(result.expiresAt).toBeLessThanOrEqual(afterTime + 3600 * 1000);
    });

    it('should throw on HTTP error response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      await expect(
        provider.exchangeCode('bad-code', 'verifier', callbackUrl)
      ).rejects.toThrow('Codex token exchange failed: HTTP 401 - Unauthorized');
    });

    it('should handle invalid JWT in id_token gracefully', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'at-7',
          refresh_token: 'rt-7',
          id_token: 'not-a-jwt',
          expires_in: 3600,
        }),
      });

      // Should not throw -- just won't extract accountId
      const result = await provider.exchangeCode('code', 'verifier', callbackUrl);
      expect(result.apiKey).toBe('at-7');
      // accountId won't be extracted from invalid JWT
      expect(result.metadata?.accountId).toBeUndefined();
    });

    it('should handle missing id_token by trying access_token', async () => {
      const accessTokenWithAccount = createMockJwt({ chatgpt_account_id: 'acct-at-only' });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: accessTokenWithAccount,
          refresh_token: 'rt-8',
          id_token: '',
          expires_in: 3600,
        }),
      });

      const result = await provider.exchangeCode('code', 'verifier', callbackUrl);
      expect(result.metadata?.accountId).toBe('acct-at-only');
    });
  });

  describe('refreshToken', () => {
    it('should POST form-urlencoded with refresh_token grant type', async () => {
      const idToken = createMockJwt({ chatgpt_account_id: 'acct-r1' });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'new-at',
          refresh_token: 'new-rt',
          id_token: idToken,
          expires_in: 3600,
        }),
      });

      await provider.refreshToken!('old-refresh-token');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://auth.openai.com/oauth/token',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
      );

      const body = new URLSearchParams(mockFetch.mock.calls[0][1].body);
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
      expect(body.get('refresh_token')).toBe('old-refresh-token');
    });

    it('should return new OAuthResult with refreshed tokens', async () => {
      const idToken = createMockJwt({ chatgpt_account_id: 'acct-r2' });
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'refreshed-at',
          refresh_token: 'rotated-rt',
          id_token: idToken,
          expires_in: 7200,
        }),
      });

      const result = await provider.refreshToken!('old-rt');

      expect(result).not.toBeNull();
      expect(result!.apiKey).toBe('refreshed-at');
      expect(result!.refreshToken).toBe('rotated-rt');
      expect(result!.expiresAt).toBeGreaterThan(Date.now());
    });

    it('should return null on HTTP error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'Invalid grant',
      });

      const result = await provider.refreshToken!('expired-rt');
      expect(result).toBeNull();
    });

    it('should return null on network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await provider.refreshToken!('some-rt');
      expect(result).toBeNull();
    });
  });
});
