/**
 * OpenAIImageAdapter tests — Images API request shape, size derivation,
 * response parsing with token-based cost, and validation.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { OpenAIImageAdapter } from '../../src/services/llm/adapters/openai/OpenAIImageAdapter';
import { AspectRatio, ImageGenerationParams } from '../../src/services/llm/types/ImageTypes';
import { jsonResponse, CapturedRequest } from './helpers/llmAdapterTestHarness';
import { TFile } from '../mocks/obsidian';

function pngBase64(width: number, height: number): string {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString('base64');
}

function imagesResponse(b64: string, size = '1024x1024', quality = 'medium', outputTokens = 1756) {
  return jsonResponse(200, {
    created: 1,
    data: [{ b64_json: b64 }],
    size,
    quality,
    output_format: 'png',
    background: 'opaque',
    usage: {
      input_tokens: 16,
      output_tokens: outputTokens,
      total_tokens: outputTokens + 16,
      output_tokens_details: { image_tokens: outputTokens, text_tokens: 0 }
    }
  });
}

function baseParams(overrides: Partial<ImageGenerationParams> = {}): ImageGenerationParams {
  return { prompt: 'a blue teacup', provider: 'openrouter', savePath: 'images/cup.png', ...overrides };
}


/** A vault holding the given files (path -> bytes) as TFiles. */
function makeVault(files: Record<string, Uint8Array>) {
  return {
    getAbstractFileByPath: (path: string) => {
      if (!(path in files)) return null;
      const file = new TFile(path.split('/').pop() || path, path);
      return file;
    },
    readBinary: async (file: { path: string }) => files[file.path].buffer.slice(0) as ArrayBuffer
  };
}

function parsedBody(request: CapturedRequest): Record<string, unknown> {
  return JSON.parse(request.body || '{}') as Record<string, unknown>;
}

describe('OpenAIImageAdapter', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('posts to /v1/images/generations with gpt-image-2 by default and exact pixels for the aspect ratio', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async (request) => {
      requests.push(request);
      return imagesResponse(pngBase64(1792, 1008), '1792x1008');
    });

    const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test' });
    await adapter.generateImage(baseParams({ aspectRatio: AspectRatio.LANDSCAPE_16_9 }));

    expect(requests[0].url).toBe('https://api.openai.com/v1/images/generations');
    expect(requests[0].headers?.Authorization).toBe('Bearer sk-test');
    const body = parsedBody(requests[0]);
    expect(body.model).toBe('gpt-image-2');
    expect(body.size).toBe('1792x1008');
    expect(body.n).toBe(1);
    expect(body.output_format).toBe('png');
    expect(body).not.toHaveProperty('quality');
  });

  it('always sends 1024x1024 when neither size nor aspect ratio is given, so OpenAI cannot pick a high-quality 1536 default', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async (request) => {
      requests.push(request);
      return imagesResponse(pngBase64(1024, 1024));
    });

    const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test' });
    await adapter.generateImage(baseParams({ model: 'gpt-image-1-mini' }));

    expect(parsedBody(requests[0]).size).toBe('1024x1024');
  });

  it('only derives gpt-image-2 sizes whose dimensions are divisible by 16', async () => {
    const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test' });
    for (const ratio of Object.values(AspectRatio)) {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return imagesResponse(pngBase64(1024, 1024));
      });
      await adapter.generateImage(baseParams({ model: 'gpt-image-2', aspectRatio: ratio }));
      const [w, h] = String(parsedBody(requests[0]).size).split('x').map(Number);
      expect(w % 16).toBe(0);
      expect(h % 16).toBe(0);
      const [rw, rh] = ratio.split(':').map(Number);
      expect(w / h).toBeCloseTo(rw / rh, 2);
    }
  });

  it('snaps aspect ratios to the three fixed sizes for models without arbitrary sizing', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async (request) => {
      requests.push(request);
      return imagesResponse(pngBase64(1024, 1536), '1024x1536');
    });

    const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test' });
    await adapter.generateImage(baseParams({ model: 'gpt-image-1-mini', aspectRatio: AspectRatio.PORTRAIT_9_16 }));

    expect(parsedBody(requests[0]).size).toBe('1024x1536');
  });

  it('decodes b64_json, reads dimensions from the bytes and prices the tokens', async () => {
    __setRequestUrlMock(async () => imagesResponse(pngBase64(1024, 1024), '1024x1024', 'medium', 1756));

    const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test' });
    const response = await adapter.generateImage(baseParams());

    expect(response.format).toBe('png');
    expect(response.dimensions).toEqual({ width: 1024, height: 1024 });
    expect(response.metadata.quality).toBe('medium');
    // 16 input tokens at $8/M + 1756 output tokens at $30/M
    expect(response.metadata.reportedCostUsd).toBeCloseTo(0.052808, 6);
  });

  it('surfaces a 400 without retrying', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async (request) => {
      requests.push(request);
      return jsonResponse(400, { error: { message: 'Invalid value: 1792x1024', type: 'invalid_request_error' } });
    });

    const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test' });
    await expect(adapter.generateImage(baseParams({ model: 'gpt-image-1', size: '1792x1024' }))).rejects.toThrow(/Invalid value/);
    expect(requests).toHaveLength(1);
  });

  describe('validation', () => {
    const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test' });

    it('fills in gpt-image-2 as the default', () => {
      const result = adapter.validateImageParams(baseParams());
      expect(result.isValid).toBe(true);
      expect(result.adjustedParams?.model).toBe('gpt-image-2');
    });

    it('rejects reference images when no vault is configured to read them', () => {
      const result = adapter.validateImageParams(baseParams({ referenceImages: ['refs/a.png'] }));
      expect(result.isValid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/Vault not configured/);
    });

    it('caps reference images at 16 and rejects unsupported formats', () => {
      const withVault = new OpenAIImageAdapter({ apiKey: 'sk-test', vault: makeVault({}) as never });
      const tooMany = Array.from({ length: 17 }, (_, i) => `refs/${i}.png`);
      expect(withVault.validateImageParams(baseParams({ referenceImages: tooMany })).errors.join(' ')).toMatch(/at most 16/);
      expect(withVault.validateImageParams(baseParams({ referenceImages: ['refs/a.gif'] })).errors.join(' ')).toMatch(/Invalid reference image format/);
      expect(withVault.validateImageParams(baseParams({ referenceImages: ['refs/a.png', 'refs/b.webp'] })).isValid).toBe(true);
    });

    it('rejects a non-standard size for a fixed-size model but allows it for gpt-image-2', () => {
      expect(adapter.validateImageParams(baseParams({ model: 'gpt-image-1', size: '1792x1024' })).isValid).toBe(false);
      expect(adapter.validateImageParams(baseParams({ model: 'gpt-image-2', size: '1792x1024' })).isValid).toBe(true);
    });

    it('drops imageSize with a warning', () => {
      const result = adapter.validateImageParams(baseParams({ imageSize: '4K' }));
      expect(result.isValid).toBe(true);
      expect(result.adjustedParams).toHaveProperty('imageSize', undefined);
    });
  });

  it('lists every supported model with a per-image price', async () => {
    const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test' });
    const models = await adapter.listModels();
    expect(models.map(m => m.id).sort()).toEqual([...adapter.supportedModels].sort());
    for (const model of models) {
      expect(model.pricing?.imageGeneration).toBeGreaterThan(0);
    }
  });

  describe('reference images (edits endpoint)', () => {
    it('posts a multipart body with every reference image as image[] to /images/edits', async () => {
      const requests: CapturedRequest[] = [];
      const b64 = pngBase64(1024, 1024);
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return imagesResponse(b64);
      });

      const refA = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const refB = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 5, 6]);
      const adapter = new OpenAIImageAdapter({
        apiKey: 'sk-test',
        vault: makeVault({ 'refs/a.png': refA, 'refs/b.webp': refB }) as never
      });

      const response = await adapter.generateImage(baseParams({
        model: 'gpt-image-1.5',
        aspectRatio: AspectRatio.LANDSCAPE_16_9,
        referenceImages: ['refs/a.png', 'refs/b.webp']
      }));

      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe('https://api.openai.com/v1/images/edits');
      expect(requests[0].method).toBe('POST');
      expect(requests[0].headers?.Authorization).toBe('Bearer sk-test');
      const contentType = requests[0].headers?.['Content-Type'] || '';
      expect(contentType).toMatch(/^multipart\/form-data; boundary=/);

      const rawBody = requests[0].body as unknown;
      expect(rawBody).toBeInstanceOf(ArrayBuffer);
      const body = Buffer.from(rawBody as ArrayBuffer).toString('latin1');
      const boundary = contentType.split('boundary=')[1];
      const parts = body.split(`--${boundary}`).filter(p => p.includes('Content-Disposition'));

      const field = (name: string) => parts.find(p => p.includes(`name="${name}"`)) || '';
      expect(field('model')).toContain('\r\n\r\ngpt-image-1.5\r\n');
      expect(field('prompt')).toContain('\r\n\r\na blue teacup\r\n');
      expect(field('n')).toContain('\r\n\r\n1\r\n');
      expect(field('size')).toContain('\r\n\r\n1536x1024\r\n');
      expect(field('output_format')).toContain('\r\n\r\npng\r\n');

      const images = parts.filter(p => p.includes('name="image[]"'));
      expect(images).toHaveLength(2);
      expect(images[0]).toContain('filename="a.png"');
      expect(images[0]).toContain('Content-Type: image/png');
      expect(images[0]).toContain(Buffer.from(refA).toString('latin1'));
      expect(images[1]).toContain('filename="b.webp"');
      expect(images[1]).toContain('Content-Type: image/webp');
      expect(images[1]).toContain(Buffer.from(refB).toString('latin1'));

      expect(response.format).toBe('png');
      expect(response.dimensions).toEqual({ width: 1024, height: 1024 });
    });

    it('fails before any request when a reference image is missing from the vault', async () => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return imagesResponse(pngBase64(1024, 1024));
      });

      const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test', vault: makeVault({}) as never });

      await expect(adapter.generateImage(baseParams({ referenceImages: ['refs/missing.png'] })))
        .rejects.toThrow(/Reference image not found: refs\/missing.png/);
      expect(requests).toHaveLength(0);
    });
  });
});
