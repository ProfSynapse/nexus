/**
 * LLMValidationService key checks.
 *
 * A check that sends a test message names a model, and fails every key once the
 * provider retires that model (OpenRouter's free Liquid LFM model did exactly
 * this). Providers that can check a key without naming a model must do so.
 */

import { __setRequestUrlMock } from 'obsidian';
import { LLMValidationService } from '../../src/services/llm/validation/ValidationService';

const mockRequestUrl = jest.fn();

type Validator = (apiKey: string) => Promise<{ success: boolean; error?: string }>;
const validator = (name: string): Validator =>
  (LLMValidationService as unknown as Record<string, Validator>)[name].bind(LLMValidationService);

const MODEL_FREE_CHECKS: Array<[string, string, string, string]> = [
  ['validateOpenRouter', 'https://openrouter.ai/api/v1/key', 'Authorization', 'Bearer test-key'],
  ['validateAnthropic', 'https://api.anthropic.com/v1/models', 'x-api-key', 'test-key'],
  ['validateGoogle', 'https://generativelanguage.googleapis.com/v1beta/models', 'x-goog-api-key', 'test-key'],
  ['validateMistral', 'https://api.mistral.ai/v1/models', 'Authorization', 'Bearer test-key'],
  ['validateGroq', 'https://api.groq.com/openai/v1/models', 'Authorization', 'Bearer test-key'],
  ['validateDeepSeek', 'https://api.deepseek.com/models', 'Authorization', 'Bearer test-key'],
  ['validateOpenAI', 'https://api.openai.com/v1/models', 'Authorization', 'Bearer test-key']
];

describe('LLMValidationService', () => {
  beforeEach(() => {
    mockRequestUrl.mockReset();
    __setRequestUrlMock(mockRequestUrl);
  });

  describe.each(MODEL_FREE_CHECKS)('%s', (name, url, header, headerValue) => {
    it('checks the key with an authenticated GET that names no model', async () => {
      mockRequestUrl.mockResolvedValue({ status: 200, json: { data: [] }, text: '{}', headers: {} });

      await expect(validator(name)('test-key')).resolves.toEqual({ success: true });

      expect(mockRequestUrl).toHaveBeenCalledTimes(1);
      const request = mockRequestUrl.mock.calls[0][0];
      expect(request.url).toBe(url);
      expect(request.method).toBe('GET');
      expect(request.body).toBeUndefined();
      expect(request.headers[header]).toBe(headerValue);
    });

    it('reports the provider error for a rejected key', async () => {
      mockRequestUrl.mockResolvedValue({
        status: 401,
        json: { error: { message: 'Invalid API key' } },
        text: '{"error":{"message":"Invalid API key"}}',
        headers: {}
      });

      await expect(validator(name)('bad-key')).resolves.toEqual({ success: false, error: 'Invalid API key' });
    });
  });

  it('reads Mistral-style errors that put the message in detail', async () => {
    mockRequestUrl.mockResolvedValue({
      status: 401,
      json: { detail: 'Invalid API Key' },
      text: '{"detail":"Invalid API Key"}',
      headers: {}
    });

    await expect(validator('validateMistral')('bad-key')).resolves.toEqual({ success: false, error: 'Invalid API Key' });
  });

  it('falls back to the HTTP status when the error body is empty', async () => {
    mockRequestUrl.mockResolvedValue({ status: 403, json: null, text: '', headers: {} });

    await expect(validator('validateGroq')('bad-key')).resolves.toEqual({ success: false, error: 'HTTP 403' });
  });
  it('accepts an OpenAI key that is refused only the model list (restricted key)', async () => {
    mockRequestUrl.mockResolvedValue({
      status: 403,
      json: { error: { message: 'You have insufficient permissions for this operation. Missing scopes: api.model.read.' } },
      text: '',
      headers: {}
    });

    await expect(validator('validateOpenAI')('restricted-key')).resolves.toEqual({ success: true });
  });

  describe.each([['validatePerplexity'], ['validateRequesty']])('%s', (name) => {
    it('accepts the key when only the test model is unavailable', async () => {
      mockRequestUrl.mockResolvedValue({
        status: 404,
        json: { error: { message: 'No endpoints found for openai/gpt-5-nano.' } },
        text: '',
        headers: {}
      });

      await expect(validator(name)('test-key')).resolves.toEqual({ success: true });
    });

    it('rejects a key the provider refuses', async () => {
      mockRequestUrl.mockResolvedValue({
        status: 401,
        json: { error: { message: 'Invalid model access token' } },
        text: '',
        headers: {}
      });

      await expect(validator(name)('bad-key')).resolves.toEqual({ success: false, error: 'Invalid model access token' });
    });

    it('rejects a 400 that blames the key even when it mentions a model', async () => {
      mockRequestUrl.mockResolvedValue({
        status: 400,
        json: { error: { message: 'Invalid API key for model sonar' } },
        text: '',
        headers: {}
      });

      await expect(validator(name)('bad-key')).resolves.toEqual({ success: false, error: 'Invalid API key for model sonar' });
    });
  });
});
