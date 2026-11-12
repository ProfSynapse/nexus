/** RUN_COMPATIBLE_CONTEXT_LIVE=1 COMPATIBLE_CONTEXT_BASE_URL=http://127.0.0.1:8080/v1 \
 *  COMPATIBLE_CONTEXT_SERVED=2048 npx jest tests/debug/openai-compatible-context-live.test.ts --runInBand --no-coverage
 *
 * Context discovery and the Check request against a real, already-running server
 * started with a known context (llama.cpp `-c 2048`, vLLM `--max-model-len 2048`).
 * Set COMPATIBLE_CONTEXT_OVERSIZE=truncated for servers that shorten long prompts
 * instead of refusing them (Ollama). requestUrl is bridged to fetch; not in-app proof.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';
import { discoverOpenAICompatibleModels } from '../../src/services/llm/adapters/openai-compatible/OpenAICompatibleConfig';
import { checkOpenAICompatibleContextWindow } from '../../src/services/llm/adapters/openai-compatible/OpenAICompatibleContextCheck';

const describeLive = process.env.RUN_COMPATIBLE_CONTEXT_LIVE === '1' ? describe : describe.skip;
describeLive('OpenAI-compatible context window against a live server', () => {
  const baseUrl = process.env.COMPATIBLE_CONTEXT_BASE_URL || 'http://127.0.0.1:8080/v1';
  const apiKey = process.env.COMPATIBLE_CONTEXT_API_KEY || '';
  const served = Number(process.env.COMPATIBLE_CONTEXT_SERVED || '2048');
  const oversize = process.env.COMPATIBLE_CONTEXT_OVERSIZE || 'too-large';
  let model = process.env.COMPATIBLE_CONTEXT_MODEL || '';

  beforeAll(async () => {
    __setRequestUrlMock(async request => {
      const response = await fetch(request.url!, { method: request.method, headers: request.headers, body: request.body });
      const text = await response.text();
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: response.status, text, json, headers: {}, arrayBuffer: new ArrayBuffer(0) };
    });
    if (!model) model = (await discoverOpenAICompatibleModels(baseUrl, apiKey))[0].id;
  });

  test('discovery reports the context the server was started with', async () => {
    const found = (await discoverOpenAICompatibleModels(baseUrl, apiKey)).find(entry => entry.id === model);
    expect(found?.contextWindow).toBe(served);
  }, 60_000);

  test('a Check at the served size fits', async () => {
    const result = await checkOpenAICompatibleContextWindow({ baseUrl, apiKey, model, contextWindow: served });
    expect(result.kind).toBe('fits');
  }, 600_000);

  test('a Check at four times the served size is caught', async () => {
    const result = await checkOpenAICompatibleContextWindow({ baseUrl, apiKey, model, contextWindow: served * 4 });
    expect(result.kind).toBe(oversize);
    if (result.kind === 'too-large' && result.serverLimit !== undefined) expect(result.serverLimit).toBe(served);
    // eslint-disable-next-line no-console -- the live lane's evidence is the server's own words
    console.log(JSON.stringify(result));
  }, 600_000);
});
