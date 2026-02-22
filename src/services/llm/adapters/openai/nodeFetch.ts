/**
 * Node.js custom fetch for OpenAI SDK — CORS bypass
 * Location: src/services/llm/adapters/openai/nodeFetch.ts
 *
 * Obsidian runs in an Electron renderer with origin app://obsidian.md.
 * The OpenAI Responses API (api.openai.com/v1/responses) does NOT return
 * Access-Control-Allow-Origin headers, so browser fetch() is blocked by CORS.
 *
 * This module provides a drop-in fetch replacement using Node.js https
 * module (available in Electron's renderer when nodeIntegration is enabled).
 * It returns a spec-compliant Response with a ReadableStream body so the
 * OpenAI SDK can iterate it for streaming SSE events.
 *
 * Security: Only HTTPS URLs are permitted. Plain HTTP is rejected.
 *
 * Used by: OpenAIAdapter.ts, OpenAIImageAdapter.ts — passed to the OpenAI
 * SDK constructor via the `fetch` option.
 */

/** Maximum number of redirects to follow before giving up */
const MAX_REDIRECTS = 5;

/** Request timeout in milliseconds (matches Codex adapter's 2-minute timeout) */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * Normalize header keys to lowercase.
 * HTTP headers are case-insensitive per RFC 7230 §3.2. Normalizing to
 * lowercase avoids case-mismatch bugs (e.g., Content-Length vs content-length).
 */
function normalizeHeaders(raw: HeadersInit | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!raw) return headers;

  if (raw instanceof Headers) {
    raw.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  } else if (Array.isArray(raw)) {
    for (const [key, value] of raw) { headers[key.toLowerCase()] = value; }
  } else {
    for (const [key, value] of Object.entries(raw)) {
      headers[key.toLowerCase()] = value;
    }
  }
  return headers;
}

/**
 * Custom fetch using Node.js https to bypass CORS.
 * Conforms to the standard fetch signature expected by the OpenAI SDK:
 *   (input: string | URL | Request, init?: RequestInit) => Promise<Response>
 *
 * Follows redirects (up to MAX_REDIRECTS hops), strips Authorization on
 * cross-origin redirects, enforces HTTPS-only, and applies a request timeout.
 */
export function nodeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  // Extract URL string from the various input types
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : (input as Request).url;

  // Build headers: init.headers override input.headers (per Fetch spec)
  const headers = normalizeHeaders(init?.headers);

  // Merge headers from Request object if input is a Request (init takes precedence)
  if (typeof input !== 'string' && !(input instanceof URL) && (input as Request).headers) {
    (input as Request).headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (!(lowerKey in headers)) { headers[lowerKey] = value; }
    });
  }

  const method = init?.method
    || (typeof input !== 'string' && !(input instanceof URL) ? (input as Request).method : 'GET');

  // Prepare request body
  let bodyData: string | Buffer | undefined;
  if (init?.body) {
    if (typeof init.body === 'string') {
      bodyData = init.body;
    } else if (Buffer.isBuffer(init.body)) {
      bodyData = init.body;
    } else if (init.body instanceof ArrayBuffer) {
      bodyData = Buffer.from(init.body);
    } else if (init.body instanceof Uint8Array) {
      bodyData = Buffer.from(init.body);
    } else {
      // Fallback for other body types (FormData, ReadableStream, etc.)
      bodyData = String(init.body);
    }
  }

  // Set content-length if not already present (keys are already lowercase)
  if (bodyData && !headers['content-length']) {
    headers['content-length'] = String(
      Buffer.byteLength(typeof bodyData === 'string' ? bodyData : bodyData)
    );
  }

  return executeRequest(url, method, headers, bodyData, init?.signal ?? null, 0);
}

/**
 * Execute a single HTTP request, recursing on redirects.
 *
 * Redirect security: Authorization header is stripped when the redirect
 * target has a different origin than the original request. This prevents
 * credential leakage to third-party servers (e.g., CDN or logging endpoints).
 */
function executeRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  bodyData: string | Buffer | undefined,
  signal: AbortSignal | null,
  redirectCount: number
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);

    // Security: only HTTPS is permitted
    if (parsedUrl.protocol !== 'https:') {
      reject(new Error(`nodeFetch: only HTTPS URLs are allowed, got ${parsedUrl.protocol}`));
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const https = require('https') as typeof import('https');

    const req = https.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers
      },
      (nodeRes) => {
        const statusCode = nodeRes.statusCode ?? 0;

        // Handle redirects (301, 302, 303, 307, 308)
        if (statusCode >= 300 && statusCode < 400 && nodeRes.headers.location) {
          // Consume the redirect response body to free the socket
          nodeRes.resume();

          if (redirectCount >= MAX_REDIRECTS) {
            reject(new Error(`nodeFetch: too many redirects (max ${MAX_REDIRECTS})`));
            return;
          }

          const redirectUrl = new URL(nodeRes.headers.location, url);

          // Security: strip Authorization header on cross-origin redirects
          // to prevent credential leakage to third-party servers
          const redirectHeaders = { ...headers };
          if (redirectUrl.origin !== parsedUrl.origin) {
            delete redirectHeaders['authorization'];
          }

          // 303 always becomes GET with no body; 301/302 become GET for non-GET/HEAD
          // (matches browser fetch behavior). 307/308 preserve method and body.
          let redirectMethod = method;
          let redirectBody = bodyData;
          if (statusCode === 303 || ((statusCode === 301 || statusCode === 302) && method !== 'GET' && method !== 'HEAD')) {
            redirectMethod = 'GET';
            redirectBody = undefined;
            delete redirectHeaders['content-length'];
            delete redirectHeaders['content-type'];
          }

          resolve(executeRequest(
            redirectUrl.toString(),
            redirectMethod,
            redirectHeaders,
            redirectBody,
            signal,
            redirectCount + 1
          ));
          return;
        }

        // Convert Node.js response headers to a Headers object
        const responseHeaders = new Headers();
        if (nodeRes.headers) {
          for (const [key, value] of Object.entries(nodeRes.headers)) {
            if (value !== undefined) {
              if (Array.isArray(value)) {
                for (const v of value) { responseHeaders.append(key, v); }
              } else {
                responseHeaders.set(key, value);
              }
            }
          }
        }

        // Create a ReadableStream from the Node.js IncomingMessage.
        // The OpenAI SDK iterates response.body for streaming SSE events.
        const body = new ReadableStream({
          start(controller) {
            nodeRes.on('data', (chunk: Buffer) => {
              controller.enqueue(new Uint8Array(chunk));
            });
            nodeRes.on('end', () => {
              controller.close();
            });
            nodeRes.on('error', (err: Error) => {
              controller.error(err);
            });
          },
          cancel() {
            nodeRes.destroy();
          }
        });

        const response = new Response(body, {
          status: statusCode,
          statusText: nodeRes.statusMessage || '',
          headers: responseHeaders
        });

        resolve(response);
      }
    );

    // Handle request-level errors (DNS failure, connection refused, etc.)
    req.on('error', reject);

    // Timeout: destroy the request if no response within threshold.
    // Matches the Codex adapter's 2-minute streaming timeout.
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`nodeFetch: request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });

    // Honor abort signal from the OpenAI SDK
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('Request aborted'));
        reject(new Error('Request aborted'));
        return;
      }
      signal.addEventListener('abort', () => {
        req.destroy(new Error('Request aborted'));
      });
    }

    // Write body and send request
    if (bodyData) {
      req.write(bodyData);
    }
    req.end();
  });
}
