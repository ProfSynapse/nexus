/**
 * OAuthCallbackServer Unit Tests
 *
 * Tests the ephemeral localhost HTTP server that receives OAuth callbacks.
 * Uses high ports (49xxx range) for tests to avoid conflicts.
 */

import http from 'node:http';
import { startCallbackServer } from '../../src/services/oauth/OAuthCallbackServer';

// Base port for tests -- each test increments from here
let testPort = 49300;
function nextPort(): number {
  return testPort++;
}

/** Helper: make a GET request to a URL */
function makeRequest(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode!, body }));
    }).on('error', reject);
  });
}

describe('OAuthCallbackServer', () => {
  describe('start and listen', () => {
    it('should start successfully and return a handle with correct callbackUrl', async () => {
      const port = nextPort();
      const handle = await startCallbackServer({
        port,
        callbackPath: '/callback',
        expectedState: 'test-state',
      });

      expect(handle).toBeDefined();
      expect(handle.port).toBe(port);
      expect(handle.callbackUrl).toBe(`http://127.0.0.1:${port}/callback`);
      expect(typeof handle.waitForCallback).toBe('function');
      expect(typeof handle.shutdown).toBe('function');

      // Cleanup
      handle.shutdown();
      await handle.waitForCallback().catch(() => {});
    });
  });

  describe('happy path: valid callback', () => {
    it('should resolve with code and state on valid callback', async () => {
      const port = nextPort();
      const expectedState = 'valid-state-123';
      const handle = await startCallbackServer({
        port,
        callbackPath: '/callback',
        expectedState,
      });

      const callbackPromise = handle.waitForCallback();

      const url = `http://127.0.0.1:${port}/callback?code=auth-code-xyz&state=${expectedState}`;
      const response = await makeRequest(url);

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Connected!');

      const result = await callbackPromise;
      expect(result.code).toBe('auth-code-xyz');
      expect(result.state).toBe(expectedState);
    });
  });

  describe('error: state mismatch', () => {
    it('should reject with CSRF error on state mismatch', async () => {
      const port = nextPort();
      const handle = await startCallbackServer({
        port,
        callbackPath: '/callback',
        expectedState: 'expected-state',
      });

      let caughtError: Error | null = null;
      const callbackPromise = handle.waitForCallback().catch((e: Error) => { caughtError = e; });

      const url = `http://127.0.0.1:${port}/callback?code=some-code&state=wrong-state`;
      const response = await makeRequest(url);

      expect(response.statusCode).toBe(400);

      await callbackPromise;
      expect(caughtError).toBeDefined();
      expect(caughtError!.message).toContain('State mismatch');
    });
  });

  describe('error: OAuth provider error', () => {
    it('should reject with error description from provider', async () => {
      const port = nextPort();
      const expectedState = 'state-abc';
      const handle = await startCallbackServer({
        port,
        callbackPath: '/callback',
        expectedState,
      });

      // Eagerly create a settled-safe promise
      let caughtError: Error | null = null;
      const callbackPromise = handle.waitForCallback().catch((e: Error) => { caughtError = e; });

      const url = `http://127.0.0.1:${port}/callback?error=access_denied&error_description=User+denied+access&state=${expectedState}`;
      const response = await makeRequest(url);

      expect(response.statusCode).toBe(400);

      await callbackPromise;
      expect(caughtError).toBeDefined();
      expect(caughtError!.message).toContain('OAuth error: User denied access');
    });

    it('should use error code when no description is provided', async () => {
      const port = nextPort();
      const expectedState = 'state-def';
      const handle = await startCallbackServer({
        port,
        callbackPath: '/callback',
        expectedState,
      });

      let caughtError: Error | null = null;
      const callbackPromise = handle.waitForCallback().catch((e: Error) => { caughtError = e; });

      const url = `http://127.0.0.1:${port}/callback?error=server_error&state=${expectedState}`;
      const response = await makeRequest(url);

      expect(response.statusCode).toBe(400);

      await callbackPromise;
      expect(caughtError).toBeDefined();
      expect(caughtError!.message).toContain('OAuth error: server_error');
    });
  });

  describe('error: missing code', () => {
    it('should reject when authorization code is missing', async () => {
      const port = nextPort();
      const expectedState = 'state-ghi';
      const handle = await startCallbackServer({
        port,
        callbackPath: '/callback',
        expectedState,
      });

      let caughtError: Error | null = null;
      const callbackPromise = handle.waitForCallback().catch((e: Error) => { caughtError = e; });

      const url = `http://127.0.0.1:${port}/callback?state=${expectedState}`;
      const response = await makeRequest(url);

      expect(response.statusCode).toBe(400);

      await callbackPromise;
      expect(caughtError).toBeDefined();
      expect(caughtError!.message).toContain('Missing authorization code');
    });
  });

  describe('non-callback path', () => {
    it('should return 404 for non-callback paths', async () => {
      const port = nextPort();
      const handle = await startCallbackServer({
        port,
        callbackPath: '/callback',
        expectedState: 'state-jkl',
      });

      const url = `http://127.0.0.1:${port}/other-path`;
      const response = await makeRequest(url);

      expect(response.statusCode).toBe(404);
      expect(response.body).toBe('Not found');

      // Cleanup
      handle.shutdown();
      await handle.waitForCallback().catch(() => {});
    });
  });

  describe('timeout', () => {
    it('should reject with timeout error after configured timeout', async () => {
      const port = nextPort();
      const handle = await startCallbackServer({
        port,
        callbackPath: '/callback',
        expectedState: 'state-timeout',
        timeoutMs: 100,
      });

      let caughtError: Error | null = null;
      await handle.waitForCallback().catch((e: Error) => { caughtError = e; });

      expect(caughtError).toBeDefined();
      expect(caughtError!.message).toContain('OAuth callback timeout');
    });
  });

  describe('shutdown', () => {
    it('should reject callback promise when shut down before callback', async () => {
      const port = nextPort();
      const handle = await startCallbackServer({
        port,
        callbackPath: '/callback',
        expectedState: 'state-shutdown',
      });

      let caughtError: Error | null = null;
      const callbackPromise = handle.waitForCallback().catch((e: Error) => { caughtError = e; });

      handle.shutdown();
      await callbackPromise;

      expect(caughtError).toBeDefined();
      expect(caughtError!.message).toContain('shut down');
    });

    it('should be idempotent (calling shutdown twice is safe)', async () => {
      const port = nextPort();
      const handle = await startCallbackServer({
        port,
        callbackPath: '/callback',
        expectedState: 'state-idempotent',
      });

      const callbackPromise = handle.waitForCallback().catch(() => {});

      handle.shutdown();
      expect(() => handle.shutdown()).not.toThrow();

      await callbackPromise;
    });
  });

  describe('EADDRINUSE', () => {
    it('should reject with descriptive error when port is in use', async () => {
      const port = nextPort();

      // Occupy the port
      const blockingServer = http.createServer();
      await new Promise<void>((resolve) => blockingServer.listen(port, '127.0.0.1', resolve));

      try {
        await expect(
          startCallbackServer({
            port,
            callbackPath: '/callback',
            expectedState: 'state-busy',
          })
        ).rejects.toThrow(`Port ${port} is already in use`);
      } finally {
        blockingServer.close();
      }
    });
  });
});
