/**
 * Provider HTTP Client
 * Location: src/services/llm/adapters/shared/ProviderHttpClient.ts
 *
 * Centralized HTTP client for all LLM provider adapters.
 * Uses Obsidian's requestUrl for buffered requests (CORS-safe) and
 * Node.js https/http modules for real streaming (Electron-only).
 *
 * Used by: BaseAdapter.request(), BaseAdapter.requestStream()
 */

import { requestUrl } from 'obsidian';
import { LLMProviderError } from '../types';
import { hasNodeRuntime } from '../../../../utils/platform';

export interface ProviderHttpRequest {
  url: string;
  provider: string;
  operation: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  retryOnStatuses?: number[];
}

export interface ProviderStreamRequest {
  url: string;
  provider: string;
  operation: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProviderHttpResponse<TJson = unknown> {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  text: string;
  json: TJson | null;
  arrayBuffer: ArrayBuffer;
}

interface ErrorLikeResponse {
  status: number;
  statusText: string;
  data: unknown;
  text: string;
  json: unknown;
}

export class ProviderHttpError extends Error {
  response: ErrorLikeResponse;

  constructor(message: string, response: ErrorLikeResponse) {
    super(message);
    this.name = 'ProviderHttpError';
    this.response = response;
  }
}

/**
 * Check whether a URL targets localhost (http allowed) or a remote host (https required).
 * Throws if a remote URL uses http://.
 */
function enforceHttps(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol === 'http:') {
    const hostname = parsed.hostname;
    const isLocalhost = hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]';
    if (!isLocalhost) {
      throw new Error(
        `Insecure HTTP request blocked: ${parsed.origin}. Use HTTPS for remote providers. ` +
        'HTTP is only allowed for localhost (Ollama, LM Studio).'
      );
    }
  }
}

export class ProviderHttpClient {
  static async request<TJson = unknown>(
    config: ProviderHttpRequest
  ): Promise<ProviderHttpResponse<TJson>> {
    enforceHttps(config.url);

    const retries = config.retries ?? 0;
    const retryDelayMs = config.retryDelayMs ?? 500;
    const retryOnStatuses = config.retryOnStatuses ?? [408, 409, 429, 500, 502, 503, 504];

    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await this.requestOnce<TJson>(config);

        if (response.ok || !retryOnStatuses.includes(response.status) || attempt === retries) {
          return response;
        }

        lastError = new ProviderHttpError(
          `${config.operation} failed with HTTP ${response.status}`,
          {
            status: response.status,
            statusText: `HTTP ${response.status}`,
            data: response.json ?? response.text,
            text: response.text,
            json: response.json,
          }
        );
      } catch (error) {
        lastError = error;
        if (attempt === retries) {
          break;
        }
      }

      await this.sleep(retryDelayMs * Math.pow(2, attempt));
    }

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new LLMProviderError(
      `${config.operation} failed`,
      config.provider,
      'NETWORK_ERROR'
    );
  }

  static async requestJson<TJson = unknown>(config: ProviderHttpRequest): Promise<TJson | null> {
    const response = await this.request<TJson>(config);
    return response.json;
  }

  static async requestText(config: ProviderHttpRequest): Promise<string> {
    const response = await this.request(config);
    return response.text;
  }

  static assertOk<TJson = unknown>(
    response: ProviderHttpResponse<TJson>,
    message?: string
  ): ProviderHttpResponse<TJson> {
    if (response.ok) {
      return response;
    }

    throw new ProviderHttpError(
      message || `HTTP ${response.status}`,
      {
        status: response.status,
        statusText: `HTTP ${response.status}`,
        data: response.json ?? response.text,
        text: response.text,
        json: response.json,
      }
    );
  }

  /**
   * Make a streaming HTTP request using Node.js https/http modules.
   * Returns a Node.js IncomingMessage (readable stream) that yields chunks as they arrive.
   *
   * This bypasses Obsidian's requestUrl (which buffers the entire response) and uses
   * the native Node.js HTTP stack available in Electron for true wire-level streaming.
   *
   * Falls back to a buffered requestUrl approach on mobile where Node.js is unavailable.
   */
  static async requestStream(
    config: ProviderStreamRequest
  ): Promise<NodeJS.ReadableStream> {
    enforceHttps(config.url);

    if (!hasNodeRuntime()) {
      // Mobile fallback: use requestUrl (fully buffered) and wrap as a readable stream
      return this.requestStreamBufferedFallback(config);
    }

    const parsed = new URL(config.url);
    const isHttps = parsed.protocol === 'https:';

    // Dynamically require Node.js modules (available in Electron)
    const nodeModule = isHttps
      ? require('https') as typeof import('https')
      : require('http') as typeof import('http');

    const timeoutMs = config.timeoutMs ?? 120_000;

    return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      const requestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: config.method ?? 'POST',
        headers: config.headers ?? {},
      };

      const req = nodeModule.request(requestOptions, (res) => {
        const status = res.statusCode ?? 0;

        if (status < 200 || status >= 300) {
          // Read the error body then reject
          let errorBody = '';
          res.on('data', (chunk: Buffer) => { errorBody += chunk.toString(); });
          res.on('end', () => {
            let errorJson: unknown = null;
            try { errorJson = JSON.parse(errorBody); } catch { /* not JSON */ }

            reject(new ProviderHttpError(
              `${config.operation} failed with HTTP ${status}`,
              {
                status,
                statusText: res.statusMessage ?? `HTTP ${status}`,
                data: errorJson ?? errorBody,
                text: errorBody,
                json: errorJson,
              }
            ));
          });
          res.on('error', (err) => reject(err));
          return;
        }

        resolve(res);
      });

      // Timeout handling
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Stream request timeout after ${timeoutMs}ms`));
      });

      req.on('error', (err) => {
        reject(err);
      });

      // Abort support
      if (config.signal) {
        if (config.signal.aborted) {
          req.destroy(new Error('Request aborted'));
          reject(new Error('Request aborted'));
          return;
        }
        config.signal.addEventListener('abort', () => {
          req.destroy(new Error('Request aborted'));
        }, { once: true });
      }

      // Write body and send
      if (config.body) {
        req.write(config.body);
      }
      req.end();
    });
  }

  /**
   * Mobile fallback: use Obsidian's requestUrl and wrap the buffered response
   * as a single-chunk readable stream.
   */
  private static async requestStreamBufferedFallback(
    config: ProviderStreamRequest
  ): Promise<NodeJS.ReadableStream> {
    const response = await requestUrl({
      url: config.url,
      method: config.method ?? 'POST',
      headers: config.headers,
      body: config.body,
      throw: false,
    });

    const status = response.status;
    if (status < 200 || status >= 300) {
      let errorJson: unknown = null;
      try { errorJson = response.json; } catch { /* not JSON */ }

      throw new ProviderHttpError(
        `${config.operation} failed with HTTP ${status}`,
        {
          status,
          statusText: `HTTP ${status}`,
          data: errorJson ?? response.text,
          text: response.text,
          json: errorJson,
        }
      );
    }

    // Wrap the buffered text as a minimal readable stream
    const { Readable } = require('stream') as typeof import('stream');
    const readable = new Readable({
      read() {
        this.push(Buffer.from(response.text, 'utf-8'));
        this.push(null);
      }
    });

    return readable;
  }

  private static async requestOnce<TJson = unknown>(
    config: ProviderHttpRequest
  ): Promise<ProviderHttpResponse<TJson>> {
    const response = await this.requestWithTimeout({
      url: config.url,
      method: config.method ?? 'GET',
      headers: config.headers,
      body: config.body,
      throw: false,
    }, config.timeoutMs ?? 30_000);

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      headers: response.headers,
      text: response.text,
      json: (response.json ?? null) as TJson | null,
      arrayBuffer: response.arrayBuffer,
    };
  }

  private static async requestWithTimeout(
    request: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: string | ArrayBuffer;
      throw: boolean;
    },
    timeoutMs: number
  ): Promise<Awaited<ReturnType<typeof requestUrl>>> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Request timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      requestUrl(request)
        .then((response) => {
          clearTimeout(timeoutId);
          resolve(response);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
