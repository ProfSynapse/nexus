/** RUN_OPENAI_COMPATIBLE_LIVE=1 npx jest tests/debug/openai-compatible-live.test.ts --runInBand --no-coverage
 * Exercises the production adapter/transport against an already-running local Ollama.
 * Obsidian requestUrl is bridged to real fetch for buffered calls; this is not in-app proof.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { __setRequestUrlMock } from '../mocks/obsidian';
jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'), isDesktop: () => true, hasNodeRuntime: () => true,
}));
jest.mock('../../src/utils/desktopRequire', () => ({ desktopRequire: (name: string) => jest.requireActual(name) }));
import { OpenAICompatibleAdapter } from '../../src/services/llm/adapters/openai-compatible/OpenAICompatibleAdapter';
import type { LLMProviderConfig } from '../../src/types';
import type { StreamChunk } from '../../src/services/llm/adapters/types';

const describeLive = process.env.RUN_OPENAI_COMPATIBLE_LIVE === '1' ? describe : describe.skip;
describeLive('OpenAI-compatible live adapter', () => {
  const model = process.env.COMPATIBLE_LIVE_MODEL || 'qwen3.5:4b';
  function adapter(baseUrl = 'http://127.0.0.1:11434/v1'): OpenAICompatibleAdapter {
    const config: LLMProviderConfig = { apiKey: '', enabled: true, driverKind: 'openai-compatible',
      openaiCompatible: { schemaVersion: 1, displayName: 'Live', baseUrl, models: { [model]: { source: 'manual' } } } };
    return new OpenAICompatibleAdapter(config, 'endpoint-live');
  }
  beforeAll(() => {
    __setRequestUrlMock(async request => {
      const response = await fetch(request.url!, { method: request.method, headers: request.headers, body: request.body });
      const text = await response.text();
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { /* SSE */ }
      return { status: response.status, text, json, headers: {}, arrayBuffer: new ArrayBuffer(0) };
    });
  });
  test('buffered text and token usage', async () => {
    const result = await adapter().generateUncached('Reply with exactly endpoint connection confirmed');
    expect(result.text.toLowerCase()).toContain('endpoint connection confirmed');
    expect(result.provider).toBe('endpoint-live');
    expect(result.usage?.completionTokens).toBeGreaterThan(0);
  }, 300_000);
  test('real streamed text arrives across multiple chunks before completion', async () => {
    const textChunks: Array<{ at: number; content: string }> = [];
    let final: StreamChunk | undefined;
    for await (const chunk of adapter().generateStreamAsync('Reply with exactly endpoint connection confirmed')) {
      if (chunk.content) textChunks.push({ at: performance.now(), content: chunk.content });
      final = chunk;
    }
    expect(textChunks.map(chunk => chunk.content).join('').toLowerCase()).toContain('endpoint connection confirmed');
    expect(textChunks.length).toBeGreaterThan(1);
    expect(textChunks.at(-1)!.at).toBeGreaterThan(textChunks[0].at);
    expect(final?.complete).toBe(true);
    // Minimal stream requests do not force include_usage; some servers omit it.
    if (final?.usage) expect(final.usage.completionTokens).toBeGreaterThan(0);
  }, 300_000);
  test('real tool result with fresh post-call code round-trips through production adapter', async () => {
    const endpoint = adapter();
    const tools = [{ type: 'function' as const, function: { name: 'read_test_note', description: 'Read the synthetic note and its verificationCode.', parameters: { type: 'object', properties: { noteId: { type: 'string', enum: ['endpoint-smoke'] } }, required: ['noteId'], additionalProperties: false } } }];
    const messages: Array<Record<string, unknown>> = [{ role: 'user', content: 'Use read_test_note to read noteId endpoint-smoke. Then reply with its exact verificationCode. The code is unknown until you read it.' }];
    let first: StreamChunk | undefined;
    for await (const chunk of endpoint.generateStreamAsync('', { conversationHistory: messages, tools })) first = chunk;
    expect(first?.toolCalls).toHaveLength(1);
    const call = first!.toolCalls![0];
    expect(call.function.name).toBe('read_test_note');
    expect(JSON.parse(call.function.arguments)).toEqual({ noteId: 'endpoint-smoke' });
    const verificationCode = `NEXUS-${randomBytes(8).toString('hex')}`;
    messages.push({ role: 'assistant', content: '', tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ noteId: 'endpoint-smoke', verificationCode }) });
    let final: StreamChunk | undefined;
    let text = '';
    for await (const chunk of endpoint.generateStreamAsync('', { conversationHistory: messages, tools })) { text += chunk.content; final = chunk; }
    expect(text).toContain(verificationCode);
    expect(final?.toolCalls).toBeUndefined();
  }, 300_000);
  test('invalid live model throws a streaming HTTP error', async () => {
    await expect((async () => {
      for await (const _ of adapter().generateStreamAsync('Hello', { model: `nexus-nonexistent-${randomBytes(8).toString('hex')}` })) { /* drain */ }
    })()).rejects.toThrow(/HTTP 404/);
  }, 30_000);
  test('actual HTTP200 midstream failure retains partial text and never completes', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      response.end('data: {"error":{"message":"deliberate fixture failure"}}\n\n');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
    const chunks: StreamChunk[] = [];
    try {
      await expect((async () => {
        for await (const chunk of adapter(`http://127.0.0.1:${address.port}/v1`).generateStreamAsync('hello')) chunks.push(chunk);
      })()).rejects.toThrow('deliberate fixture failure');
      expect(chunks.map(chunk => chunk.content).join('')).toBe('partial');
      expect(chunks.some(chunk => chunk.complete)).toBe(false);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }, 30_000);
  test('caller cancellation after response headers aborts the real body', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      // Stay open until the caller cancels; no remote work or model is involved.
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
    const controller = new AbortController();
    const stream = adapter(`http://127.0.0.1:${address.port}/v1`).generateStreamAsync('hello', { abortSignal: controller.signal });
    try {
      expect((await stream.next()).value).toMatchObject({ content: 'partial', complete: false });
      controller.abort();
      await expect(stream.next()).rejects.toThrow(/aborted/i);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }, 30_000);
});
