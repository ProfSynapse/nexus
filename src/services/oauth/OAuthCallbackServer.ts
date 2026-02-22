/**
 * OAuthCallbackServer.ts
 * Location: src/services/oauth/OAuthCallbackServer.ts
 *
 * Ephemeral localhost HTTP server that receives a single OAuth callback.
 * Binds to 127.0.0.1 ONLY (not 'localhost', not 0.0.0.0) for security.
 * Single-use: accepts one valid callback, then shuts down immediately.
 * Auto-shuts down after a configurable timeout (default 5 minutes).
 *
 * Used by: OAuthService.ts (starts server before opening browser,
 * waits for callback, then shuts down).
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { URL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

/** Common no-cache headers for all callback responses (prevents browser caching auth codes) */
const NO_CACHE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store, no-cache',
  'Pragma': 'no-cache',
};

/** Result from a successful OAuth callback */
export interface CallbackResult {
  /** Authorization code from the OAuth provider */
  code: string;
  /** State parameter for CSRF validation */
  state: string;
}

/** Handle returned by OAuthCallbackServer.start() */
export interface CallbackServerHandle {
  /** The port the server is listening on */
  port: number;
  /** Full callback URL (e.g., http://127.0.0.1:3000/callback) */
  callbackUrl: string;
  /** Promise that resolves when a valid callback is received */
  waitForCallback(): Promise<CallbackResult>;
  /** Force shutdown the server (idempotent) */
  shutdown(): void;
}

/** Shared CSS for callback pages — respects system light/dark preference */
const CALLBACK_STYLE = `
<style>
  body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
  .wrap{text-align:center}
  @media(prefers-color-scheme:dark){body{background:#1a1a2e;color:#e0e0e0}}
  @media(prefers-color-scheme:light){body{background:#fff;color:#1a1a1a}}
</style>`;

/** Static HTML success page -- no dynamic content for security */
const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head><title>Authorization Successful</title>${CALLBACK_STYLE}</head>
<body>
<div class="wrap">
<h1 style="color:#4ade80">Connected!</h1>
<p>You can close this tab and return to Obsidian.</p>
</div>
<script>setTimeout(function(){window.close()},2000)</script>
</body>
</html>`;

/** Static HTML error page */
const HTML_ERROR = `<!DOCTYPE html>
<html>
<head><title>Authorization Failed</title>${CALLBACK_STYLE}</head>
<body>
<div class="wrap">
<h1 style="color:#f87171">Authorization Failed</h1>
<p>Something went wrong. Please close this tab and try again in Obsidian.</p>
</div>
</body>
</html>`;

/**
 * Options for starting the callback server.
 */
export interface CallbackServerOptions {
  /** Port to bind to */
  port: number;
  /** URL path to listen for callbacks on (e.g., '/callback') */
  callbackPath: string;
  /** Expected state parameter value for CSRF validation */
  expectedState: string;
  /** Timeout in milliseconds before auto-shutdown (default: 300_000 = 5 minutes) */
  timeoutMs?: number;
  /** Hostname used in the callbackUrl string (default: '127.0.0.1'). Server always binds to 127.0.0.1. */
  callbackUrlHostname?: string;
}

/**
 * Start an ephemeral OAuth callback server.
 *
 * @param options - Server configuration
 * @returns Handle with port, callbackUrl, waitForCallback(), and shutdown()
 * @throws Error with descriptive message on EADDRINUSE or other server errors
 */
export function startCallbackServer(options: CallbackServerOptions): Promise<CallbackServerHandle> {
  const {
    port,
    callbackPath,
    expectedState,
    timeoutMs = 300_000,
    callbackUrlHostname = '127.0.0.1',
  } = options;

  return new Promise<CallbackServerHandle>((resolveStart, rejectStart) => {
    let settled = false;
    let callbackResolve: ((result: CallbackResult) => void) | null = null;
    let callbackReject: ((error: Error) => void) | null = null;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let server: Server | null = null;

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (server) {
        try {
          server.close();
        } catch {
          // Ignore close errors during cleanup
        }
        server = null;
      }
    };

    const shutdown = () => {
      if (!settled) {
        settled = true;
        if (callbackReject) {
          callbackReject(new Error('OAuth callback server was shut down'));
        }
      }
      cleanup();
    };

    // Create the callback promise that callers await
    const callbackPromise = new Promise<CallbackResult>((resolve, reject) => {
      callbackResolve = resolve;
      callbackReject = reject;
    });

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Only handle GET requests to the callback path
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

      if (url.pathname !== callbackPath) {
        res.writeHead(404, { 'Content-Type': 'text/plain', ...NO_CACHE_HEADERS });
        res.end('Not found');
        return;
      }

      // Check for OAuth error from provider
      const error = url.searchParams.get('error');
      const errorDescription = url.searchParams.get('error_description');
      if (error) {
        const msg = errorDescription || error;
        res.writeHead(400, { 'Content-Type': 'text/html', ...NO_CACHE_HEADERS });
        res.end(HTML_ERROR);
        if (!settled) {
          settled = true;
          callbackReject?.(new Error(`OAuth error: ${msg}`));
          cleanup();
        }
        return;
      }

      // Validate state parameter (CSRF protection via timing-safe comparison)
      const state = url.searchParams.get('state') || '';
      const stateValid =
        state.length === expectedState.length &&
        timingSafeEqual(Buffer.from(state), Buffer.from(expectedState));
      if (!stateValid) {
        res.writeHead(400, { 'Content-Type': 'text/html', ...NO_CACHE_HEADERS });
        res.end(HTML_ERROR);
        if (!settled) {
          settled = true;
          callbackReject?.(new Error('State mismatch: potential CSRF attack'));
          cleanup();
        }
        return;
      }

      // Extract authorization code
      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html', ...NO_CACHE_HEADERS });
        res.end(HTML_ERROR);
        if (!settled) {
          settled = true;
          callbackReject?.(new Error('Missing authorization code in callback'));
          cleanup();
        }
        return;
      }

      // Success: return static HTML and resolve the callback promise
      res.writeHead(200, { 'Content-Type': 'text/html', ...NO_CACHE_HEADERS });
      res.end(HTML_SUCCESS);

      if (!settled) {
        settled = true;
        callbackResolve?.({ code, state });
        cleanup();
      }
    });

    // Handle server errors (including EADDRINUSE)
    server.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      if (err.code === 'EADDRINUSE') {
        rejectStart(new Error(
          `Port ${port} is already in use. If MCP HTTP transport is running on this port, please use manual API key entry.`
        ));
      } else {
        rejectStart(new Error(`OAuth callback server error: ${err.message}`));
      }
    });

    // Bind to 127.0.0.1 ONLY -- never 'localhost' (resolves to IPv6 on some systems), never 0.0.0.0
    server.listen(port, '127.0.0.1', () => {
      // Set up timeout for auto-shutdown
      timeoutHandle = setTimeout(() => {
        if (!settled) {
          settled = true;
          callbackReject?.(new Error('OAuth callback timeout: authorization took too long'));
          cleanup();
        }
      }, timeoutMs);

      // Return the handle
      resolveStart({
        port,
        callbackUrl: `http://${callbackUrlHostname}:${port}${callbackPath}`,
        waitForCallback: () => callbackPromise,
        shutdown,
      });
    });
  });
}
