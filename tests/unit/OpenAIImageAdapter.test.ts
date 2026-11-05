/**
 * OpenAIImageAdapter tests — Images API request shape, size derivation,
 * response parsing with token-based cost, and validation.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { OPENAI_IMAGE_ASPECT_RATIOS, OpenAIImageAdapter } from '../../src/services/llm/adapters/openai/OpenAIImageAdapter';
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

  describe.each(['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2.6-sunburst', 'gpt-image-2.6-flare'])('%s', model => {
    it.each([false, true])('sends explicit medium quality and size (edit=%s)', async edit => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        return imagesResponse(pngBase64(1024, 1024));
      });
      const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test', vault: makeVault({ 'refs/mug.png': new Uint8Array([1, 2, 3]) }) as never });
      await adapter.generateImage(baseParams({ model, referenceImages: edit ? ['refs/mug.png'] : undefined }));
      if (edit) {
        const body = Buffer.from(requests[0].body as unknown as ArrayBuffer).toString('latin1');
        expect(body).toContain('name="quality"\r\n\r\nmedium');
        expect(body).toContain('name="model"\r\n\r\n' + model);
        expect(body).toContain('name="size"\r\n\r\n1024x1024');
      } else {
        expect(parsedBody(requests[0])).toMatchObject({ model, quality: 'medium', size: '1024x1024' });
      }
    });

    it.each(['1820x1024', '512x512', '4096x1024', '3840x3840', '2048x512'])('rejects invalid pixel dimensions %s before requesting', async size => {
      const request = jest.fn(async () => imagesResponse(pngBase64(1024, 1024)));
      __setRequestUrlMock(request);
      const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test' });
      expect(adapter.validateImageParams(baseParams({ model, size })).isValid).toBe(false);
      await expect(adapter.generateImage(baseParams({ model, size }))).rejects.toThrow(/dimensions/);
      expect(request).not.toHaveBeenCalled();
    });

    it('validates dimensions derived from aspect ratios as well as explicit sizes', () => {
      const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test' });
      expect(adapter.validateImageParams(baseParams({ model, aspectRatio: '4:1' as AspectRatio })).isValid).toBe(false);
      expect(adapter.validateImageParams(baseParams({ model, size: '3840x2160' })).isValid).toBe(true);
      expect(adapter.validateImageParams(baseParams({ model, aspectRatio: AspectRatio.LANDSCAPE_16_9 })).isValid).toBe(true);
    });

    it('prices text and reference image input at their distinct token rates', async () => {
      __setRequestUrlMock(async () => jsonResponse(200, {
        data: [{ b64_json: pngBase64(1024, 1024) }],
        usage: { input_tokens: 120, input_tokens_details: { text_tokens: 20, image_tokens: 100 }, output_tokens: 1000 }
      }));
      const result = await new OpenAIImageAdapter({ apiKey: 'sk-test' }).generateImage(baseParams({ model }));
      expect(result.metadata.reportedCostUsd).toBeCloseTo((20 * 5 + 100 * 8 + 1000 * 30) / 1000000, 8);
    });
  });

  describe.each(['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare'])('%s features', model => {
    function capture(respond: () => ReturnType<typeof imagesResponse> = () => imagesResponse(pngBase64(1024, 1024))) {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        return respond();
      });
      return requests;
    }

    function multipart(request: CapturedRequest): string {
      return Buffer.from(request.body as unknown as ArrayBuffer).toString('latin1');
    }

    it('leaves complexity to the endpoint unless the caller sets it', async () => {
      const requests = capture();
      const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test' });
      await adapter.generateImage(baseParams({ model }));
      await adapter.generateImage(baseParams({ model, complexity: 'low' }));
      expect(parsedBody(requests[0])).not.toHaveProperty('complexity');
      expect(parsedBody(requests[1]).complexity).toBe('low');
    });

    it('asks for SVG with an authoring model and adds its tokens to the cost', async () => {
      const svg = '<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg"></svg>';
      const requests = capture(() => jsonResponse(200, {
        data: [{ b64_json: Buffer.from(svg).toString('base64') }],
        output_format: 'svg',
        size: '1024x1024',
        usage: { input_tokens: 100, input_tokens_details: { text_tokens: 100, image_tokens: 0 }, output_tokens: 1000 },
        svg_usage: { model: 'gpt-6-luna', input_tokens: 2000, output_tokens: 4000, reasoning_tokens: 1500, total_tokens: 6000 }
      }));

      const response = await new OpenAIImageAdapter({ apiKey: 'sk-test' }).generateImage(baseParams({ model, outputFormat: 'svg' }));

      expect(parsedBody(requests[0])).toMatchObject({ output_format: 'svg', n: 1, svg: { model: 'gpt-6-luna' } });
      expect(response.format).toBe('svg');
      expect(response.imageData.toString('utf8')).toBe(svg);
      expect(response.dimensions).toEqual({ width: 1024, height: 1024 });
      // Image: 100 text at $5, 1000 output at $30. gpt-6-luna: 2000 in at $0.10, 4000 out at $0.50.
      expect(response.metadata.reportedCostUsd).toBeCloseTo((100 * 5 + 1000 * 30 + 2000 * 0.1 + 4000 * 0.5) / 1000000, 8);
    });

    it('sends GIF frame settings and lets the endpoint size frames when no ratio is given', async () => {
      const requests = capture(() => jsonResponse(200, {
        data: [{ b64_json: Buffer.from('GIF89a').toString('base64') }],
        output_format: 'gif',
        size: '512x512',
        usage: { input_tokens: 10, output_tokens: 500 }
      }));

      const response = await new OpenAIImageAdapter({ apiKey: 'sk-test' })
        .generateImage(baseParams({ model, outputFormat: 'gif', frameCount: 4, frameDurationMs: 150 }));

      expect(parsedBody(requests[0])).toMatchObject({ output_format: 'gif', size: 'auto', frame_count: 4, frame_duration_ms: 150 });
      expect(response.format).toBe('gif');
      expect(response.dimensions).toEqual({ width: 512, height: 512 });
    });

    it('sizes GIF frames for the sprite sheet rather than near a megapixel', async () => {
      const requests = capture(() => imagesResponse(pngBase64(768, 432)));
      const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test' });
      const params = baseParams({ model, outputFormat: 'gif', aspectRatio: AspectRatio.LANDSCAPE_16_9 });
      expect(adapter.validateImageParams(params).isValid).toBe(true);
      await adapter.generateImage(params);
      expect(parsedBody(requests[0]).size).toBe('768x432');
    });

    it('never sends frame settings on a raster request', async () => {
      const requests = capture();
      await new OpenAIImageAdapter({ apiKey: 'sk-test' }).generateImage(baseParams({ model }));
      const body = parsedBody(requests[0]);
      expect(body.output_format).toBe('png');
      expect(body).not.toHaveProperty('frame_count');
      expect(body).not.toHaveProperty('frame_duration_ms');
      expect(body).not.toHaveProperty('svg');
    });

    it('sends the markup overlay as its own part, after the images, with complexity', async () => {
      const requests = capture();
      const vault = makeVault({ 'refs/room.png': new Uint8Array([1, 2]), 'refs/circle.png': new Uint8Array([3, 4]) });
      const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test', vault: vault as never });
      const params = baseParams({ model, referenceImages: ['refs/room.png'], markupImage: 'refs/circle.png', complexity: 'low' });

      expect(adapter.validateImageParams(params).isValid).toBe(true);
      await adapter.generateImage(params);

      expect(requests[0].url).toBe('https://api.openai.com/v1/images/edits');
      const body = multipart(requests[0]);
      expect(body).toContain('name="complexity"\r\n\r\nlow');
      expect(body).toMatch(/name="image\[\]"; filename="room\.png"/);
      expect(body).toMatch(/name="markup"; filename="circle\.png"/);
      expect(body.indexOf('name="markup"')).toBeGreaterThan(body.indexOf('name="image[]"'));
    });

    it.each([
      ['GIF with reference images', { outputFormat: 'gif', referenceImages: ['refs/a.png'] }, /generation only/],
      ['SVG with reference images', { outputFormat: 'svg', referenceImages: ['refs/a.png'] }, /generation only/],
      ['frameCount without GIF', { frameCount: 4 }, /require outputFormat "gif"/],
      ['frameDurationMs on SVG', { outputFormat: 'svg', frameDurationMs: 100 }, /require outputFormat "gif"/],
      ['17 frames, which the endpoint rejects despite the guide', { outputFormat: 'gif', frameCount: 17 }, /2 to 16/],
      ['1 frame', { outputFormat: 'gif', frameCount: 1 }, /2 to 16/],
      ['a frame shorter than 20 ms', { outputFormat: 'gif', frameDurationMs: 10 }, /at least 20/],
      ['a GIF ratio outside 1:3 to 3:1', { outputFormat: 'gif', aspectRatio: '4:1' }, /does not support aspect ratio 4:1/],
      ['markup without a reference image', { markupImage: 'refs/m.png' }, /referenceImages is required/],
      ['markup that is not a PNG', { markupImage: 'refs/m.webp', referenceImages: ['refs/a.png'] }, /transparent PNG/],
    ])('rejects %s before anything is billed', (_label, overrides, message) => {
      const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test', vault: makeVault({}) as never });
      const result = adapter.validateImageParams(baseParams({ model, ...(overrides as Partial<ImageGenerationParams>) }));
      expect(result.isValid).toBe(false);
      expect(result.errors.join(' ')).toMatch(message);
    });
  });

  describe('models without the GPT Image 2.6 features', () => {
    it.each(['gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'])('%s drops complexity with a warning and rejects the rest', async model => {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async request => {
        requests.push(request);
        return imagesResponse(pngBase64(1024, 1024));
      });
      const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test', vault: makeVault({}) as never });

      const complexity = adapter.validateImageParams(baseParams({ model, complexity: 'low' }));
      expect(complexity.isValid).toBe(true);
      expect(complexity.warnings?.join(' ')).toMatch(/no complexity setting/);
      await adapter.generateImage(baseParams({ model, complexity: 'low' }));
      expect(parsedBody(requests[0])).not.toHaveProperty('complexity');

      for (const outputFormat of ['svg', 'gif'] as const) {
        expect(adapter.validateImageParams(baseParams({ model, outputFormat })).errors.join(' ')).toMatch(/cannot produce/);
      }
      const markup = adapter.validateImageParams(baseParams({ model, markupImage: 'refs/m.png', referenceImages: ['refs/a.png'] }));
      expect(markup.errors.join(' ')).toMatch(/does not support markupImage/);
    });
  });

  describe('generation deadline', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    function slowResponse(ms: number) {
      __setRequestUrlMock(async () => {
        await new Promise(resolve => setTimeout(resolve, ms));
        return imagesResponse(pngBase64(1024, 1024));
      });
    }

    it('gives SVG longer than the two minutes a raster image gets', async () => {
      slowResponse(200_000);
      const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test' });

      const svg = adapter.generateImageWithResponse(baseParams({ model: 'gpt-image-2.6-flare', outputFormat: 'svg' }));
      await jest.advanceTimersByTimeAsync(200_000);
      expect((await svg).result.success).toBe(true);

      const raster = adapter.generateImageWithResponse(baseParams({ model: 'gpt-image-2.6-flare' }));
      await jest.advanceTimersByTimeAsync(200_000);
      expect((await raster).result.success).toBe(false);
    });
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
    await adapter.generateImage(baseParams({ model: 'gpt-image-2' }));

    expect(parsedBody(requests[0]).size).toBe('1024x1024');
  });

  it.each(['gpt-image-2', 'gpt-image-2.6-flare'])('%s rejects ratios past 3:1, which the API refuses, before requesting', model => {
    const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test' });
    for (const ratio of ['1:4', '4:1', '1:8', '8:1'] as AspectRatio[]) {
      const result = adapter.validateImageParams(baseParams({ model, aspectRatio: ratio }));
      expect(result.isValid).toBe(false);
      expect(result.errors.join(' ')).toContain(`does not support aspect ratio ${ratio}`);
    }
  });

  it('has a GIF frame size for every offered ratio', async () => {
    const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test' });
    for (const ratio of OPENAI_IMAGE_ASPECT_RATIOS as AspectRatio[]) {
      const requests: CapturedRequest[] = [];
      __setRequestUrlMock(async (request) => {
        requests.push(request);
        return imagesResponse(pngBase64(512, 512));
      });
      await adapter.generateImage(baseParams({ model: 'gpt-image-2.6-flare', outputFormat: 'gif', aspectRatio: ratio }));
      const [w, h] = String(parsedBody(requests[0]).size).split('x').map(Number);
      expect(w * h).toBeLessThanOrEqual(768 * 432);
      const [rw, rh] = ratio.split(':').map(Number);
      expect(w / h).toBeCloseTo(rw / rh, 2);
    }
  });

  it('reports numberOfImages as ignored, since one request makes one image', () => {
    const result = new OpenAIImageAdapter({ apiKey: 'sk-test' }).validateImageParams(baseParams({ numberOfImages: 3 }));
    expect(result.isValid).toBe(true);
    expect(result.warnings?.join(' ')).toMatch(/numberOfImages 3 ignored/);
  });

  it('only derives gpt-image-2 sizes whose dimensions are divisible by 16', async () => {
    const adapter = new OpenAIImageAdapter({ apiKey: 'sk-test' });
    for (const ratio of OPENAI_IMAGE_ASPECT_RATIOS as AspectRatio[]) {
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
    await expect(adapter.generateImage(baseParams({ model: 'gpt-image-2', size: '1792x1024' }))).rejects.toThrow(/Invalid value/);
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

    it('rejects a size that is not WIDTHxHEIGHT and accepts an arbitrary one for gpt-image-2', () => {
      expect(adapter.validateImageParams(baseParams({ model: 'gpt-image-2', size: 'large' })).isValid).toBe(false);
      expect(adapter.validateImageParams(baseParams({ model: 'gpt-image-2', size: '1792x1024' })).isValid).toBe(true);
    });

    it('no longer offers the retired GPT Image 1 family', () => {
      for (const retired of ['gpt-image-1', 'gpt-image-1.5', 'gpt-image-1-mini']) {
        expect(adapter.supportedModels).not.toContain(retired);
        expect(adapter.validateImageParams(baseParams({ model: retired })).isValid).toBe(false);
      }
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
        model: 'gpt-image-2',
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
      expect(field('model')).toContain('\r\n\r\ngpt-image-2\r\n');
      expect(field('prompt')).toContain('\r\n\r\na blue teacup\r\n');
      expect(field('n')).toContain('\r\n\r\n1\r\n');
      expect(field('size')).toContain('\r\n\r\n1792x1008\r\n');
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
