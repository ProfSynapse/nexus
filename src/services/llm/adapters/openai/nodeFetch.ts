/**
 * Node.js custom fetch for OpenAI SDK — CORS bypass
 * Location: src/services/llm/adapters/openai/nodeFetch.ts
 *
 * Obsidian runs in an Electron renderer with origin app://obsidian.md.
 * The OpenAI Responses API (api.openai.com/v1/responses) does NOT return
 * Access-Control-Allow-Origin headers, so browser fetch() is blocked by CORS.
 *
 * This module provides a drop-in fetch replacement using Node.js http/https
 * modules (available in Electron's renderer when nodeIntegration is enabled).
 * It returns a spec-compliant Response with a ReadableStream body so the
 * OpenAI SDK can iterate it for streaming SSE events.
 *
 * Used by: OpenAIAdapter.ts, OpenAIImageAdapter.ts — passed to the OpenAI
 * SDK constructor via the `fetch` option.
 */

/**
 * Custom fetch using Node.js http/https to bypass CORS.
 * Conforms to the standard fetch signature expected by the OpenAI SDK:
 *   (input: string | URL | Request, init?: RequestInit) => Promise<Response>
 */
export function nodeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    // Extract URL string from the various input types
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;

    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const httpModule = isHttps
      ? require('https') as typeof import('https')
      : require('http') as typeof import('http');

    // Build headers from RequestInit
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => { headers[key] = value; });
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) { headers[key] = value; }
      } else {
        Object.assign(headers, init.headers);
      }
    }

    // Merge headers from Request object if input is a Request
    if (typeof input !== 'string' && !(input instanceof URL) && (input as Request).headers) {
      (input as Request).headers.forEach((value, key) => {
        if (!(key in headers)) { headers[key] = value; }
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

    // Set Content-Length if not already present
    if (bodyData && !headers['content-length'] && !headers['Content-Length']) {
      headers['Content-Length'] = String(
        Buffer.byteLength(typeof bodyData === 'string' ? bodyData : bodyData)
      );
    }

    const req = httpModule.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers
      },
      (nodeRes) => {
        const statusCode = nodeRes.statusCode ?? 0;

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

    // Honor abort signal from the OpenAI SDK
    if (init?.signal) {
      init.signal.addEventListener('abort', () => {
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
