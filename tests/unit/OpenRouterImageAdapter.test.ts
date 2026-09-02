/**
 * OpenRouterImageAdapter tests.
 *
 * The adapter speaks OpenRouter's dedicated Image API (POST /api/v1/images).
 * These tests pin the request shape per model family, the b64_json response
 * parsing, and the failure paths — all at the requestUrl seam, no network.
 */
import { __setRequestUrlMock, TFile } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { OpenRouterImageAdapter } from '../../src/services/llm/adapters/openrouter/OpenRouterImageAdapter';
import { AspectRatio, ImageGenerationParams } from '../../src/services/llm/types/ImageTypes';
import { jsonResponse, CapturedRequest } from './helpers/llmAdapterTestHarness';

/** Minimal valid PNG header (IHDR) declaring the given dimensions. */
function pngBase64(width: number, height: number): string {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString('base64');
}

/** Minimal JPEG: SOI, then an SOF0 segment declaring the given dimensions. */
function jpegBase64(width: number, height: number): string {
  const buf = Buffer.alloc(2 + 2 + 2 + 5 + 2);
  buf.writeUInt16BE(0xffd8, 0);        // SOI
  buf.writeUInt16BE(0xffc0, 2);        // SOF0
  buf.writeUInt16BE(11, 4);            // segment length
  buf.writeUInt8(8, 6);                // precision
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf.toString('base64');
}

function imagesResponse(b64: string, mediaType = 'image/png', cost = 0.04) {
  return jsonResponse(200, {
    created: 1_748_372_400,
    data: [{ b64_json: b64, media_type: mediaType }],
    usage: {
      prompt_tokens: 7,
      completion_tokens: 1120,
      total_tokens: 1127,
      cost,
      completion_tokens_details: { image_tokens: 1120 }
    }
  });
}

function baseParams(overrides: Partial<ImageGenerationParams> = {}): ImageGenerationParams {
  return {
    prompt: 'a red circle',
    provider: 'openrouter',
    savePath: 'images/circle.png',
    ...overrides
  };
}

function parsedBody(request: CapturedRequest): Record<string, unknown> {
  return JSON.parse(request.body || '{}') as Record<string, unknown>;
}

describe('OpenRouterImageAdapter', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('request shape', () => {
    it('posts to /api/v1/images with the GA Gemini 2.5 id for the default model', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return imagesResponse(pngBase64(1024, 1024));
      });

      const adapter = new OpenRouterImageAdapter({ apiKey: 'or-test' });
      await adapter.generateImage(baseParams());

      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe('https://openrouter.ai/api/v1/images');
      expect(requests[0].method).toBe('POST');
      expect(requests[0].headers?.Authorization).toBe('Bearer or-test');

      const body = parsedBody(requests[0]);
      // The retired google/gemini-2.5-flash-image-preview id returns "No endpoints found".
      expect(body.model).toBe('google/gemini-2.5-flash-image');
      expect(body.prompt).toBe('a red circle');
      expect(body).not.toHaveProperty('modalities');
      expect(body).not.toHaveProperty('messages');
      expect(body).not.toHaveProperty('n');
    });

    it('sends aspect_ratio and maps imageSize to the resolution enum for Gemini 3.x', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return imagesResponse(pngBase64(512, 288));
      });

      const adapter = new OpenRouterImageAdapter({ apiKey: 'or-test' });
      await adapter.generateImage(baseParams({
        model: 'gemini-3.1-flash-image-preview',
        aspectRatio: AspectRatio.LANDSCAPE_16_9,
        imageSize: '512px'
      }));

      const body = parsedBody(requests[0]);
      expect(body.model).toBe('google/gemini-3.1-flash-image-preview');
      expect(body.aspect_ratio).toBe('16:9');
      expect(body.resolution).toBe('512');
    });

    it('never sends resolution to a model whose endpoint does not accept it', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return imagesResponse(pngBase64(1024, 1024), 'image/jpeg');
      });

      const adapter = new OpenRouterImageAdapter({ apiKey: 'or-test' });
      await adapter.generateImage(baseParams({ model: 'flux-2-pro', imageSize: '2K' }));

      const body = parsedBody(requests[0]);
      expect(body.model).toBe('black-forest-labs/flux.2-pro');
      expect(body).not.toHaveProperty('resolution');
    });

    it('sends vault reference images as data-URL input_references', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return imagesResponse(pngBase64(1024, 1024));
      });

      const pngBytes = Buffer.from(pngBase64(2, 2), 'base64');
      const file = new TFile('ref.png', 'refs/ref.png');
      const vault = {
        getAbstractFileByPath: jest.fn((path: string) => (path === 'refs/ref.png' ? file : null)),
        readBinary: jest.fn(async () => pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength))
      };

      const adapter = new OpenRouterImageAdapter({ apiKey: 'or-test', vault: vault as never });
      await adapter.generateImage(baseParams({ referenceImages: ['refs/ref.png'] }));

      const body = parsedBody(requests[0]);
      const refs = body.input_references as Array<{ type: string; image_url: { url: string } }>;
      expect(refs).toHaveLength(1);
      expect(refs[0].type).toBe('image_url');
      expect(refs[0].image_url.url).toBe(`data:image/png;base64,${pngBytes.toString('base64')}`);
    });

    it('fails clearly when a reference image is missing from the vault', async () => {
      __setRequestUrlMock(async () => imagesResponse(pngBase64(1, 1)));
      const vault = { getAbstractFileByPath: jest.fn(() => null), readBinary: jest.fn() };
      const adapter = new OpenRouterImageAdapter({ apiKey: 'or-test', vault: vault as never });

      await expect(adapter.generateImage(baseParams({ referenceImages: ['nope.png'] })))
        .rejects.toThrow(/Reference image not found: nope.png/);
      expect(vault.readBinary).not.toHaveBeenCalled();
    });
  });

  describe('response parsing', () => {
    it('decodes b64_json, takes the format from media_type and reads PNG dimensions', async () => {
      __setRequestUrlMock(async () => imagesResponse(pngBase64(1344, 768), 'image/png', 0.067));

      const adapter = new OpenRouterImageAdapter({ apiKey: 'or-test' });
      const response = await adapter.generateImage(baseParams({
        model: 'gemini-3.1-flash-image-preview',
        aspectRatio: AspectRatio.LANDSCAPE_16_9
      }));

      expect(response.format).toBe('png');
      expect(response.dimensions).toEqual({ width: 1344, height: 768 });
      expect(response.imageData.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      expect(response.metadata.openRouterModel).toBe('google/gemini-3.1-flash-image-preview');
      expect(response.metadata.reportedCostUsd).toBe(0.067);
      expect(response.usage?.imagesGenerated).toBe(1);
      expect(response.usage?.resolution).toBe('1344x768');
    });

    it('reads JPEG dimensions when the provider returns jpeg regardless of the requested format', async () => {
      __setRequestUrlMock(async () => imagesResponse(jpegBase64(832, 1248), 'image/jpeg'));

      const adapter = new OpenRouterImageAdapter({ apiKey: 'or-test' });
      const response = await adapter.generateImage(baseParams({ aspectRatio: AspectRatio.PORTRAIT_2_3 }));

      expect(response.format).toBe('jpeg');
      expect(response.dimensions).toEqual({ width: 832, height: 1248 });
    });

    it('falls back to the aspect-ratio dimensions when the header cannot be read', async () => {
      __setRequestUrlMock(async () => imagesResponse(Buffer.from('not an image').toString('base64'), 'image/webp'));

      const adapter = new OpenRouterImageAdapter({ apiKey: 'or-test' });
      const response = await adapter.generateImage(baseParams({ aspectRatio: AspectRatio.SQUARE }));

      expect(response.format).toBe('webp');
      expect(response.dimensions).toEqual({ width: 1024, height: 1024 });
    });

    it('rejects a 200 with no image data', async () => {
      __setRequestUrlMock(async () => jsonResponse(200, { created: 1, data: [], usage: {} }));
      const adapter = new OpenRouterImageAdapter({ apiKey: 'or-test' });

      await expect(adapter.generateImage(baseParams())).rejects.toThrow(/No image data/);
    });
  });

  describe('errors', () => {
    it('surfaces the OpenRouter error message on a 400 and does not retry', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return jsonResponse(400, {
          error: { message: 'No provider for black-forest-labs/flux.2-pro supports the requested parameter(s): n "2"', code: 400 }
        });
      });

      const adapter = new OpenRouterImageAdapter({ apiKey: 'or-test' });
      await expect(adapter.generateImage(baseParams({ model: 'flux-2-pro' })))
        .rejects.toThrow(/supports the requested parameter/);
      expect(requests).toHaveLength(1);
    });

    it('surfaces a 404 for a model OpenRouter no longer serves', async () => {
      __setRequestUrlMock(async () => jsonResponse(404, {
        error: { message: 'No endpoints found for google/gemini-2.5-flash-image-preview.', code: 404 }
      }));

      const adapter = new OpenRouterImageAdapter({ apiKey: 'or-test' });
      await expect(adapter.generateImage(baseParams())).rejects.toThrow(/No endpoints found/);
    });
  });

  describe('validation', () => {
    const adapter = new OpenRouterImageAdapter({ apiKey: 'or-test' });

    it('fills in the default model', () => {
      const result = adapter.validateImageParams(baseParams());
      expect(result.isValid).toBe(true);
      expect(result.adjustedParams?.model).toBe('gemini-2.5-flash-image');
    });

    it('rejects an unknown model instead of guessing an OpenRouter id', () => {
      const result = adapter.validateImageParams(baseParams({ model: 'imagen-9' }));
      expect(result.isValid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/imagen-9/);
    });

    it('enforces the per-model reference image limit', () => {
      const refs = Array.from({ length: 4 }, (_, i) => `refs/${i}.png`);
      const tooMany = adapter.validateImageParams(baseParams({ model: 'gemini-2.5-flash-image', referenceImages: refs }));
      expect(tooMany.isValid).toBe(false);
      expect(tooMany.errors.join(' ')).toMatch(/Maximum is 3/);

      const ok = adapter.validateImageParams(baseParams({ model: 'gemini-3-pro-image-preview', referenceImages: refs }));
      expect(ok.isValid).toBe(true);
    });

    it('drops imageSize with a warning for models without a resolution parameter', () => {
      const result = adapter.validateImageParams(baseParams({ model: 'flux-2-pro', imageSize: '4K' }));
      expect(result.isValid).toBe(true);
      expect(result.warnings?.join(' ')).toMatch(/flux-2-pro/);
      expect(result.adjustedParams).toHaveProperty('imageSize', undefined);
    });

    it('rejects a resolution the model does not offer', () => {
      const result = adapter.validateImageParams(baseParams({ model: 'gemini-3-pro-image-preview', imageSize: '512px' }));
      expect(result.isValid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/512px/);
    });

    it('pins Seedream 4.5 to its real 2K minimum even though the endpoint lists 1K', () => {
      // Live: "requires at least 3,686,400 output pixels; size 1024x1024 is 1,048,576".
      const tooSmall = adapter.validateImageParams(baseParams({ model: 'seedream-4.5', imageSize: '1K' }));
      expect(tooSmall.isValid).toBe(false);
      expect(tooSmall.errors.join(' ')).toMatch(/2K, 4K/);

      const ok = adapter.validateImageParams(baseParams({ model: 'seedream-4.5', imageSize: '2K' }));
      expect(ok.isValid).toBe(true);
    });

    it('rejects an aspect ratio outside the OpenRouter list', () => {
      const result = adapter.validateImageParams(baseParams({ aspectRatio: '7:5' as AspectRatio }));
      expect(result.isValid).toBe(false);
    });
  });

  describe('catalog', () => {
    it('lists every supported model with a per-image price', async () => {
      const adapter = new OpenRouterImageAdapter({ apiKey: 'or-test' });
      const models = await adapter.listModels();
      expect(models.map(m => m.id).sort()).toEqual([...adapter.supportedModels].sort());
      for (const model of models) {
        expect(model.supportsImageGeneration).toBe(true);
        expect(model.pricing?.imageGeneration).toBeGreaterThan(0);
      }
    });

    it('prices FLUX.2 Flex above FLUX.2 Pro, as OpenRouter does', async () => {
      const adapter = new OpenRouterImageAdapter({ apiKey: 'or-test' });
      const pro = await adapter.getImageModelPricing('flux-2-pro');
      const flex = await adapter.getImageModelPricing('flux-2-flex');
      expect(flex.totalCost).toBeGreaterThan(pro.totalCost);
    });
  });
});
