/**
 * Shared helpers for LLM chat adapter characterization tests.
 *
 * These tests mock at the requestUrl seam (via the obsidian mock's
 * __setRequestUrlMock) and force ProviderHttpClient.requestStream onto its
 * buffered requestUrl fallback by mocking hasNodeRuntime to false in each
 * test file. No live network calls are made.
 */
import type { StreamChunk } from '../../../src/services/llm/adapters/types';

export interface MockHttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
  arrayBuffer: ArrayBuffer;
}

export interface CapturedRequest {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export function jsonResponse(status: number, json: unknown): MockHttpResponse {
  return {
    status,
    headers: {},
    text: JSON.stringify(json),
    json,
    arrayBuffer: new ArrayBuffer(0)
  };
}

export function sseResponse(text: string): MockHttpResponse {
  return {
    status: 200,
    headers: {},
    text,
    json: null,
    arrayBuffer: new ArrayBuffer(0)
  };
}

/** Build SSE wire text from a sequence of JSON events (or raw strings like '[DONE]'). */
export function sse(...events: unknown[]): string {
  return events
    .map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
    .join('');
}

export async function collect(
  stream: AsyncGenerator<StreamChunk, void, unknown>
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

export function concatContent(chunks: StreamChunk[]): string {
  return chunks.map(chunk => chunk.content).join('');
}

export async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected promise to reject');
    },
    (error: unknown) => error
  );
}
