/**
 * PerplexityAdapter request header tests.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { PerplexityAdapter } from '../../src/services/llm/adapters/perplexity/PerplexityAdapter';
import {
  jsonResponse,
  sseResponse,
  sse,
  collect,
  CapturedRequest
} from './helpers/llmAdapterTestHarness';

describe('PerplexityAdapter', () => {
  it('sends the integration header on non-streaming requests', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async (request) => {
      requests.push(request);
      return jsonResponse(200, {
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }]
      });
    });

    await new PerplexityAdapter('pplx-test').generateUncached('hi');

    expect(requests[0].url).toBe('https://api.perplexity.ai/chat/completions');
    expect(requests[0].headers?.['Authorization']).toBe('Bearer pplx-test');
    expect(requests[0].headers?.['X-Pplx-Integration']).toBe('nexus');
  });

  it('sends the integration header on streaming requests', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async (request) => {
      requests.push(request);
      return sseResponse(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'));
    });

    await collect(new PerplexityAdapter('pplx-test').generateStreamAsync('hi'));

    expect(requests[0].headers?.['X-Pplx-Integration']).toBe('nexus');
  });
});
