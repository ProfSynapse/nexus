/**
 * GeminiImageAdapter tests — request shape against generateContent, the
 * imageSize wire value, response parsing, and per-model validation.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { GeminiImageAdapter } from '../../src/services/llm/adapters/google/GeminiImageAdapter';
import { AspectRatio, ImageGenerationParams } from '../../src/services/llm/types/ImageTypes';
import { jsonResponse, CapturedRequest } from './helpers/llmAdapterTestHarness';

function pngBase64(width: number, height: number): string {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString('base64');
}

function geminiResponse(b64: string, mimeType = 'image/jpeg', imageTokens = 1120, modelVersion = 'gemini-3.1-flash-lite-image') {
  return jsonResponse(200, {
    candidates: [{ content: { parts: [{ text: 'Here you go.' }, { inlineData: { mimeType, data: b64 } }] } }],
    modelVersion,
    usageMetadata: {
      promptTokenCount: 8,
      candidatesTokenCount: imageTokens + 26,
      candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: imageTokens }]
    }
  });
}

function baseParams(overrides: Partial<ImageGenerationParams> = {}): ImageGenerationParams {
  return { prompt: 'a blue teacup', provider: 'google', savePath: 'images/cup.png', ...overrides };
}

function parsedBody(request: CapturedRequest): Record<string, unknown> {
  return JSON.parse(request.body || '{}') as Record<string, unknown>;
}

describe('GeminiImageAdapter', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('request shape', () => {
    it('defaults to Nano Banana 2 and posts to generateContent with the API key header', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return geminiResponse(pngBase64(1024, 1024));
      });

      const adapter = new GeminiImageAdapter({ apiKey: 'g-test' });
      await adapter.generateImage(baseParams({ aspectRatio: AspectRatio.SQUARE }));

      expect(requests[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent');
      expect(requests[0].headers?.['x-goog-api-key']).toBe('g-test');

      const body = parsedBody(requests[0]) as {
        contents: Array<{ parts: Array<{ text?: string }> }>;
        generationConfig: { responseModalities: string[]; imageConfig?: Record<string, string> };
      };
      expect(body.contents[0].parts[0].text).toBe('a blue teacup');
      expect(body.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE']);
      expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '1:1' });
    });

    it('sends imageSize "512", not "512px" — Google renders and bills "512px" as 1K', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return geminiResponse(pngBase64(512, 512), 'image/jpeg', 747, 'gemini-3.1-flash-image');
      });

      const adapter = new GeminiImageAdapter({ apiKey: 'g-test' });
      await adapter.generateImage(baseParams({ model: 'gemini-3.1-flash-image', imageSize: '512px' }));

      const body = parsedBody(requests[0]) as { generationConfig: { imageConfig?: Record<string, string> } };
      expect(body.generationConfig.imageConfig?.imageSize).toBe('512');
    });

    it('never sends imageSize to gemini-2.5-flash-image, which has no such parameter', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return geminiResponse(pngBase64(1024, 1024), 'image/png', 1290, 'gemini-2.5-flash-image');
      });

      const adapter = new GeminiImageAdapter({ apiKey: 'g-test' });
      await adapter.generateImage(baseParams({ model: 'gemini-2.5-flash-image', imageSize: '2K', aspectRatio: AspectRatio.SQUARE }));

      const body = parsedBody(requests[0]) as { generationConfig: { imageConfig?: Record<string, string> } };
      expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '1:1' });
    });
  });

  describe('response parsing', () => {
    it('reads dimensions from the bytes, format from the mime type, and prices the image tokens', async () => {
      __setRequestUrlMock(async () => geminiResponse(pngBase64(1344, 768), 'image/png', 1120, 'gemini-3-pro-image'));

      const adapter = new GeminiImageAdapter({ apiKey: 'g-test' });
      const response = await adapter.generateImage(baseParams({ model: 'gemini-3-pro-image', aspectRatio: AspectRatio.LANDSCAPE_16_9 }));

      expect(response.format).toBe('png');
      expect(response.dimensions).toEqual({ width: 1344, height: 768 });
      expect(response.metadata.imageTokens).toBe(1120);
      expect(response.metadata.reportedCostUsd).toBeCloseTo(0.134, 3);
      expect(response.metadata.modelVersion).toBe('gemini-3-pro-image');
    });

    it('rejects a response with no image part', async () => {
      __setRequestUrlMock(async () => jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'no image' }] } }] }));
      const adapter = new GeminiImageAdapter({ apiKey: 'g-test' });
      await expect(adapter.generateImage(baseParams())).rejects.toThrow(/No image data/);
    });

    it('surfaces Google 400s without retrying', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(400, { error: { code: 400, message: 'Image size 2K is not supported for this model', status: 'INVALID_ARGUMENT' } });
      });

      const adapter = new GeminiImageAdapter({ apiKey: 'g-test' });
      await expect(adapter.generateImage(baseParams())).rejects.toThrow(/not supported for this model/);
      expect(requests).toHaveLength(1);
    });
  });

  describe('validation', () => {
    const adapter = new GeminiImageAdapter({ apiKey: 'g-test' });

    it('fills in the default model', () => {
      const result = adapter.validateImageParams(baseParams());
      expect(result.isValid).toBe(true);
      expect(result.adjustedParams?.model).toBe('gemini-3.1-flash-image');
    });

    it('limits Lite to 1K and rejects 512px and 2K, as the live API does', () => {
      for (const imageSize of ['512px', '2K'] as const) {
        const result = adapter.validateImageParams(baseParams({ model: 'gemini-3.1-flash-lite-image', imageSize }));
        expect(result.isValid).toBe(false);
        expect(result.errors.join(' ')).toMatch(/Supported: 1K/);
      }
      expect(adapter.validateImageParams(baseParams({ model: 'gemini-3.1-flash-lite-image', imageSize: '1K' })).isValid).toBe(true);
    });

    it('allows 512px and 4K on Nano Banana 2 but only 1K to 4K on Pro', () => {
      expect(adapter.validateImageParams(baseParams({ model: 'gemini-3.1-flash-image', imageSize: '512px' })).isValid).toBe(true);
      expect(adapter.validateImageParams(baseParams({ model: 'gemini-3.1-flash-image', imageSize: '4K' })).isValid).toBe(true);
      expect(adapter.validateImageParams(baseParams({ model: 'gemini-3-pro-image', imageSize: '512px' })).isValid).toBe(false);
      expect(adapter.validateImageParams(baseParams({ model: 'gemini-3-pro-image', imageSize: '4K' })).isValid).toBe(true);
    });

    it('drops imageSize with a warning for the legacy 2.5 model', () => {
      const result = adapter.validateImageParams(baseParams({ model: 'gemini-2.5-flash-image', imageSize: '1K' }));
      expect(result.isValid).toBe(true);
      expect(result.warnings?.join(' ')).toMatch(/does not take an imageSize/);
      expect(result.adjustedParams).toHaveProperty('imageSize', undefined);
    });

    it('enforces the per-model reference image limit', () => {
      const refs = Array.from({ length: 4 }, (_, i) => `refs/${i}.png`);
      expect(adapter.validateImageParams(baseParams({ model: 'gemini-2.5-flash-image', referenceImages: refs })).isValid).toBe(false);
      expect(adapter.validateImageParams(baseParams({ model: 'gemini-3.1-flash-image', referenceImages: refs })).isValid).toBe(true);
    });
  });

  describe('catalog', () => {
    it('lists every supported model with a per-image price', async () => {
      const adapter = new GeminiImageAdapter({ apiKey: 'g-test' });
      const models = await adapter.listModels();
      expect(models.map(m => m.id).sort()).toEqual([...adapter.supportedModels].sort());
      for (const model of models) {
        expect(model.pricing?.imageGeneration).toBeGreaterThan(0);
      }
    });
  });
});
