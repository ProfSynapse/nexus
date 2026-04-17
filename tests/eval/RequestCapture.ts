/**
 * tests/eval/RequestCapture.ts — HTTP request/response capture layer.
 *
 * Wraps the Obsidian requestUrl mock to intercept and record all HTTP traffic
 * during eval runs. Captured data can be dumped to test-artifacts/ on failure
 * for debugging provider-specific issues.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { __setRequestUrlMock } from 'obsidian';
import type { CapturedRequest, CaptureConfig } from './types';

export class RequestCapture {
  private requests: CapturedRequest[] = [];
  private installed = false;
  private scopedRequests = new Map<string, CapturedRequest[]>();
  private scopeStorage = new AsyncLocalStorage<string | null>();

  /**
   * Install the capture layer by wrapping __setRequestUrlMock with a real
   * HTTP pass-through (via fetch) that also records request/response bodies.
   */
  install(config: CaptureConfig): void {
    if (this.installed) return;
    this.installed = true;

    if (!config.enabled) {
      // Still wire requestUrl to real HTTP, just don't capture
      this.installPassthrough();
      return;
    }

    __setRequestUrlMock(async (request) => {
      const startTime = Date.now();
      const headers: Record<string, string> = {};
      if (request.headers) {
        for (const [k, v] of Object.entries(request.headers)) {
          headers[k] = String(v);
        }
      }

      const fetchOptions: RequestInit = {
        method: request.method || 'GET',
        headers,
      };

      if (request.body !== undefined && request.body !== null) {
        if (request.body instanceof ArrayBuffer) {
          fetchOptions.body = request.body;
        } else if (typeof request.body === 'string') {
          fetchOptions.body = request.body;
        } else {
          fetchOptions.body = request.body as BodyInit;
        }
      }

      const resp = await fetch(request.url, fetchOptions);
      const arrayBuf = await resp.arrayBuffer();
      const text = new TextDecoder().decode(arrayBuf);

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = {};
      }

      // Capture the request/response pair
      let requestBody: unknown;
      try {
        requestBody = typeof request.body === 'string'
          ? JSON.parse(request.body)
          : request.body;
      } catch {
        requestBody = request.body;
      }

      const capturedRequest: CapturedRequest = {
        url: request.url,
        method: request.method || 'GET',
        headers,
        body: requestBody,
        response: {
          status: resp.status,
          headers: Object.fromEntries(resp.headers.entries()),
          body: text.length > 50_000 ? text.slice(0, 50_000) + '...[truncated]' : text,
        },
        timestamp: startTime,
      };

      this.requests.push(capturedRequest);

      const scopeId = this.scopeStorage.getStore();
      if (scopeId) {
        const scoped = this.scopedRequests.get(scopeId) ?? [];
        scoped.push(capturedRequest);
        this.scopedRequests.set(scopeId, scoped);
      }

      return {
        status: resp.status,
        headers: Object.fromEntries(resp.headers.entries()),
        text,
        json,
        arrayBuffer: arrayBuf,
      };
    });
  }

  /**
   * Install a simple pass-through without capture (same pattern as existing integration tests).
   */
  private installPassthrough(): void {
    __setRequestUrlMock(async (request) => {
      const headers: Record<string, string> = {};
      if (request.headers) {
        for (const [k, v] of Object.entries(request.headers)) {
          headers[k] = String(v);
        }
      }

      const fetchOptions: RequestInit = {
        method: request.method || 'GET',
        headers,
      };

      if (request.body !== undefined && request.body !== null) {
        if (request.body instanceof ArrayBuffer) {
          fetchOptions.body = request.body;
        } else if (typeof request.body === 'string') {
          fetchOptions.body = request.body;
        } else {
          fetchOptions.body = request.body as BodyInit;
        }
      }

      const resp = await fetch(request.url, fetchOptions);
      const arrayBuf = await resp.arrayBuffer();
      const text = new TextDecoder().decode(arrayBuf);

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = {};
      }

      return {
        status: resp.status,
        headers: Object.fromEntries(resp.headers.entries()),
        text,
        json,
        arrayBuffer: arrayBuf,
      };
    });
  }

  /**
   * Get all captured requests.
   */
  getCapturedRequests(): CapturedRequest[] {
    return [...this.requests];
  }

  /**
   * Run work inside a scenario-scoped capture context so requests can be
   * dumped independently even when scenarios execute in parallel.
   */
  async runWithScope<T>(scopeId: string, fn: () => Promise<T>): Promise<T> {
    this.scopedRequests.set(scopeId, []);
    return await this.scopeStorage.run(scopeId, fn);
  }

  /**
   * Dump captured requests to a file for a failed test.
   */
  dumpOnFailure(testName: string, artifactsDir: string): string | null {
    if (this.requests.length === 0) return null;

    const dir = path.resolve(process.cwd(), artifactsDir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const safeName = testName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(dir, `capture-${safeName}-${Date.now()}.json`);

    // Strip large response bodies for dump readability
    const sanitized = this.requests.map((r) => ({
      ...r,
      response: {
        ...r.response,
        body: r.response.body.length > 5000
          ? r.response.body.slice(0, 5000) + '...[truncated]'
          : r.response.body,
      },
    }));

    fs.writeFileSync(filePath, JSON.stringify(sanitized, null, 2));
    return filePath;
  }

  /**
   * Dump only the requests captured inside a given scope.
   */
  dumpScopeOnFailure(scopeId: string, artifactsDir: string): string | null {
    const scopedRequests = this.scopedRequests.get(scopeId) ?? [];
    if (scopedRequests.length === 0) return null;

    const dir = path.resolve(process.cwd(), artifactsDir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const safeName = scopeId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(dir, `capture-${safeName}-${Date.now()}.json`);

    const sanitized = scopedRequests.map((request) => ({
      ...request,
      response: {
        ...request.response,
        body: request.response.body.length > 5000
          ? request.response.body.slice(0, 5000) + '...[truncated]'
          : request.response.body,
      },
    }));

    fs.writeFileSync(filePath, JSON.stringify(sanitized, null, 2));
    return filePath;
  }

  /**
   * Clear all captured requests.
   */
  reset(): void {
    this.requests = [];
    this.scopedRequests.clear();
  }
}
