/**
 * OAuthService Unit Tests
 *
 * Tests the singleton OAuth service orchestrating PKCE flows:
 * - Provider registration and lookup
 * - State machine transitions (idle -> authorizing -> exchanging -> idle)
 * - Concurrent flow prevention
 * - Token refresh delegation
 * - Flow cancellation
 */

import { OAuthService } from '../../src/services/oauth/OAuthService';
import type { IOAuthProvider, OAuthProviderConfig } from '../../src/services/oauth/IOAuthProvider';

// Mock the callback server
jest.mock('../../src/services/oauth/OAuthCallbackServer', () => ({
  startCallbackServer: jest.fn(),
}));

// Mock PKCEUtils
jest.mock('../../src/services/oauth/PKCEUtils', () => ({
  generateCodeVerifier: jest.fn(() => 'mock-verifier-12345678901234567890123'),
  generateCodeChallenge: jest.fn(async () => 'mock-challenge-abc'),
  generateState: jest.fn(() => 'mock-state-xyz'),
}));

import { startCallbackServer } from '../../src/services/oauth/OAuthCallbackServer';

const mockStartCallbackServer = startCallbackServer as jest.MockedFunction<typeof startCallbackServer>;

// Mock window.open for browser launch fallback (electron require fails in test env)
const mockWindowOpen = jest.fn();
const originalWindow = (global as any).window;
(global as any).window = { open: mockWindowOpen };

/** Helper to wait for all microtasks and pending callbacks to drain */
function tick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function createMockProvider(overrides?: Partial<OAuthProviderConfig>): IOAuthProvider {
  const config: OAuthProviderConfig = {
    providerId: 'test-provider',
    displayName: 'Test Provider',
    authUrl: 'https://example.com/auth',
    tokenUrl: 'https://example.com/token',
    preferredPort: 3000,
    callbackPath: '/callback',
    scopes: ['read'],
    tokenType: 'permanent-key',
    clientId: 'test-client-id',
    ...overrides,
  };

  return {
    config,
    buildAuthUrl: jest.fn(() => 'https://example.com/auth?params=test'),
    exchangeCode: jest.fn(async () => ({ apiKey: 'test-api-key-123' })),
  };
}

function createMockProviderWithRefresh(overrides?: Partial<OAuthProviderConfig>): IOAuthProvider {
  const provider = createMockProvider({
    tokenType: 'expiring-token',
    ...overrides,
  });
  (provider as any).refreshToken = jest.fn(async () => ({
    apiKey: 'refreshed-token',
    refreshToken: 'new-refresh-token',
    expiresAt: Date.now() + 3600000,
  }));
  return provider;
}

/** Simple mock server handle for success-path tests */
function createSimpleServerHandle(code: string = 'auth-code') {
  const mockShutdown = jest.fn();
  return {
    handle: {
      port: 3000,
      callbackUrl: 'http://127.0.0.1:3000/callback',
      waitForCallback: jest.fn(async () => ({ code, state: 'mock-state-xyz' })),
      shutdown: mockShutdown,
    },
    mockShutdown,
  };
}

/** Controllable mock server handle for cancel/concurrent tests */
function createControllableServerHandle() {
  let resolveCallback!: (result: { code: string; state: string }) => void;
  let rejectCallback!: (error: Error) => void;
  let shutdownCalled = false;
  const callbackPromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const mockShutdown = jest.fn(() => {
    if (!shutdownCalled) {
      shutdownCalled = true;
      rejectCallback(new Error('OAuth callback server was shut down'));
    }
  });

  return {
    handle: {
      port: 3000,
      callbackUrl: 'http://127.0.0.1:3000/callback',
      waitForCallback: () => callbackPromise,
      shutdown: mockShutdown,
    },
    resolveCallback,
    rejectCallback,
    mockShutdown,
  };
}

describe('OAuthService', () => {
  let service: OAuthService;

  beforeEach(() => {
    OAuthService.resetInstance();
    service = OAuthService.getInstance();
    jest.clearAllMocks();
  });

  afterEach(() => {
    OAuthService.resetInstance();
  });

  afterAll(() => {
    // Restore original window to prevent mock leaking to other test files
    if (originalWindow === undefined) {
      delete (global as any).window;
    } else {
      (global as any).window = originalWindow;
    }
  });

  describe('singleton', () => {
    it('should return the same instance on subsequent calls', () => {
      const instance1 = OAuthService.getInstance();
      const instance2 = OAuthService.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should create a new instance after resetInstance()', () => {
      OAuthService.resetInstance();
      const instance2 = OAuthService.getInstance();
      expect(instance2.getState()).toBe('idle');
    });
  });

  describe('provider registration', () => {
    it('should register a provider', () => {
      const provider = createMockProvider();
      service.registerProvider(provider);
      expect(service.hasProvider('test-provider')).toBe(true);
    });

    it('should return false for unregistered provider', () => {
      expect(service.hasProvider('nonexistent')).toBe(false);
    });

    it('should return provider config for registered provider', () => {
      const provider = createMockProvider();
      service.registerProvider(provider);
      const config = service.getProviderConfig('test-provider');
      expect(config).toBeDefined();
      expect(config!.displayName).toBe('Test Provider');
    });

    it('should return null config for unregistered provider', () => {
      const config = service.getProviderConfig('nonexistent');
      expect(config).toBeNull();
    });

    it('should allow registering multiple providers', () => {
      service.registerProvider(createMockProvider({ providerId: 'provider-a' }));
      service.registerProvider(createMockProvider({ providerId: 'provider-b' }));
      expect(service.hasProvider('provider-a')).toBe(true);
      expect(service.hasProvider('provider-b')).toBe(true);
    });
  });

  describe('state machine', () => {
    it('should start in idle state', () => {
      expect(service.getState()).toBe('idle');
    });

    it('should transition through idle -> authorizing -> exchanging -> idle on success', async () => {
      const provider = createMockProvider();
      service.registerProvider(provider);

      const states: string[] = [];
      (provider.exchangeCode as jest.Mock).mockImplementation(async () => {
        states.push(service.getState());
        return { apiKey: 'key-123' };
      });

      const { handle } = createSimpleServerHandle();
      mockStartCallbackServer.mockResolvedValue(handle);

      await service.startFlow('test-provider');

      expect(states).toContain('exchanging');
      expect(service.getState()).toBe('idle');
    });

    it('should return to idle after flow cancellation', () => {
      service.cancelFlow();
      expect(service.getState()).toBe('idle');
    });
  });

  describe('startFlow', () => {
    it('should throw if provider is not registered', async () => {
      await expect(service.startFlow('nonexistent')).rejects.toThrow(
        "OAuth provider 'nonexistent' is not registered"
      );
    });

    it('should prevent concurrent flows', async () => {
      const provider = createMockProvider();
      service.registerProvider(provider);

      const { handle } = createControllableServerHandle();
      mockStartCallbackServer.mockResolvedValue(handle);

      // Start first flow (won't complete). Eagerly attach catch to prevent unhandled rejection
      const firstFlow = service.startFlow('test-provider').catch(() => {});
      await tick();

      // Second flow should be rejected
      await expect(service.startFlow('test-provider')).rejects.toThrow(
        'Cannot start OAuth flow: another flow is already authorizing'
      );

      // Clean up
      service.cancelFlow();
      await firstFlow;
    });

    it('should return to idle state even if flow fails', async () => {
      const provider = createMockProvider();
      service.registerProvider(provider);

      mockStartCallbackServer.mockRejectedValue(new Error('Port in use'));

      await expect(service.startFlow('test-provider')).rejects.toThrow('Port in use');
      expect(service.getState()).toBe('idle');
    });

    it('should call provider.buildAuthUrl with correct parameters', async () => {
      const provider = createMockProvider();
      service.registerProvider(provider);

      const { handle } = createSimpleServerHandle();
      mockStartCallbackServer.mockResolvedValue(handle);

      await service.startFlow('test-provider', { key_label: 'my-key' });

      expect(provider.buildAuthUrl).toHaveBeenCalledWith(
        'http://127.0.0.1:3000/callback',
        'mock-challenge-abc',
        'mock-state-xyz',
        { key_label: 'my-key' }
      );
    });

    it('should call provider.exchangeCode with code, verifier, and callbackUrl', async () => {
      const provider = createMockProvider();
      service.registerProvider(provider);

      const { handle } = createSimpleServerHandle('auth-code-999');
      mockStartCallbackServer.mockResolvedValue(handle);

      await service.startFlow('test-provider');

      expect(provider.exchangeCode).toHaveBeenCalledWith(
        'auth-code-999',
        'mock-verifier-12345678901234567890123',
        'http://127.0.0.1:3000/callback'
      );
    });

    it('should return the OAuthResult from provider.exchangeCode', async () => {
      const provider = createMockProvider();
      (provider.exchangeCode as jest.Mock).mockResolvedValue({
        apiKey: 'sk-or-final-key',
        refreshToken: 'rt-123',
        expiresAt: 9999999,
      });
      service.registerProvider(provider);

      const { handle } = createSimpleServerHandle();
      mockStartCallbackServer.mockResolvedValue(handle);

      const result = await service.startFlow('test-provider');
      expect(result.apiKey).toBe('sk-or-final-key');
      expect(result.refreshToken).toBe('rt-123');
    });

    it('should shut down callback server after successful flow', async () => {
      const provider = createMockProvider();
      service.registerProvider(provider);

      const { handle, mockShutdown } = createSimpleServerHandle();
      mockStartCallbackServer.mockResolvedValue(handle);

      await service.startFlow('test-provider');

      expect(mockShutdown).toHaveBeenCalled();
    });

    it('should shut down callback server on flow failure', async () => {
      const provider = createMockProvider();
      (provider.exchangeCode as jest.Mock).mockRejectedValue(new Error('Exchange failed'));
      service.registerProvider(provider);

      const { handle, mockShutdown } = createSimpleServerHandle();
      mockStartCallbackServer.mockResolvedValue(handle);

      await expect(service.startFlow('test-provider')).rejects.toThrow('Exchange failed');
      expect(mockShutdown).toHaveBeenCalled();
    });

    it('should open browser with auth URL', async () => {
      const provider = createMockProvider();
      service.registerProvider(provider);

      const { handle } = createSimpleServerHandle();
      mockStartCallbackServer.mockResolvedValue(handle);

      await service.startFlow('test-provider');

      expect(mockWindowOpen).toHaveBeenCalledWith(
        'https://example.com/auth?params=test',
        '_blank'
      );
    });
  });

  describe('cancelFlow', () => {
    it('should reset state to idle', () => {
      service.cancelFlow();
      expect(service.getState()).toBe('idle');
    });

    it('should shut down active callback server', async () => {
      const provider = createMockProvider();
      service.registerProvider(provider);

      const { handle, mockShutdown } = createControllableServerHandle();
      mockStartCallbackServer.mockResolvedValue(handle);

      // Start flow, eagerly handle rejection
      const flowPromise = service.startFlow('test-provider').catch(() => {});
      await tick();

      service.cancelFlow();

      expect(mockShutdown).toHaveBeenCalled();
      expect(service.getState()).toBe('idle');

      await flowPromise;
    });
  });

  describe('refreshToken', () => {
    it('should throw if provider is not registered', async () => {
      await expect(service.refreshToken('nonexistent', 'rt-123')).rejects.toThrow(
        "OAuth provider 'nonexistent' is not registered"
      );
    });

    it('should throw if provider does not support refresh', async () => {
      const provider = createMockProvider();
      service.registerProvider(provider);

      await expect(service.refreshToken('test-provider', 'rt-123')).rejects.toThrow(
        'does not support token refresh'
      );
    });

    it('should delegate to provider.refreshToken', async () => {
      const provider = createMockProviderWithRefresh();
      service.registerProvider(provider);

      const result = await service.refreshToken('test-provider', 'old-rt');

      expect(provider.refreshToken).toHaveBeenCalledWith('old-rt');
      expect(result!.apiKey).toBe('refreshed-token');
      expect(result!.refreshToken).toBe('new-refresh-token');
    });

    it('should return null when provider refresh returns null', async () => {
      const provider = createMockProviderWithRefresh();
      (provider.refreshToken as jest.Mock).mockResolvedValue(null);
      service.registerProvider(provider);

      const result = await service.refreshToken('test-provider', 'expired-rt');
      expect(result).toBeNull();
    });
  });

  describe('resetInstance', () => {
    it('should cancel any active flow', async () => {
      const provider = createMockProvider();
      service.registerProvider(provider);

      const { handle, mockShutdown } = createControllableServerHandle();
      mockStartCallbackServer.mockResolvedValue(handle);

      const flowPromise = service.startFlow('test-provider').catch(() => {});
      await tick();

      OAuthService.resetInstance();

      expect(mockShutdown).toHaveBeenCalled();

      await flowPromise;
    });

    it('should clear all registered providers', () => {
      service.registerProvider(createMockProvider({ providerId: 'p1' }));
      service.registerProvider(createMockProvider({ providerId: 'p2' }));

      OAuthService.resetInstance();

      const newService = OAuthService.getInstance();
      expect(newService.hasProvider('p1')).toBe(false);
      expect(newService.hasProvider('p2')).toBe(false);
    });
  });
});
