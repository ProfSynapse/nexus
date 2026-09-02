/**
 * ImageGenerationService tests.
 *
 * Pins that one service call makes exactly one provider call and saves the
 * bytes from that call. The service used to call generateImageSafely and then
 * generateImage again for the bytes, generating and billing every image twice.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';

jest.mock('../../src/utils/platform', () => ({
  ...jest.requireActual('../../src/utils/platform'),
  hasNodeRuntime: () => false,
}));

import { ImageGenerationService } from '../../src/services/llm/ImageGenerationService';
import { DEFAULT_LLM_PROVIDER_SETTINGS, LLMProviderSettings } from '../../src/types/llm/ProviderTypes';
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

function settingsWithOpenRouter(): LLMProviderSettings {
  const settings = JSON.parse(JSON.stringify(DEFAULT_LLM_PROVIDER_SETTINGS)) as LLMProviderSettings;
  settings.providers.openrouter = { ...settings.providers.openrouter, apiKey: 'or-test', enabled: true };
  return settings;
}

function makeVault() {
  const saved: Array<{ path: string; bytes: ArrayBuffer }> = [];
  const vault = {
    getAbstractFileByPath: jest.fn(() => null),
    createFolder: jest.fn(async () => undefined),
    createBinary: jest.fn(async (path: string, bytes: ArrayBuffer) => {
      saved.push({ path, bytes });
      return { path };
    })
  };
  return { vault, saved };
}

describe('ImageGenerationService', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('calls the provider exactly once per generation and saves those bytes', async () => {
    const requests: CapturedRequest[] = [];
    const b64 = pngBase64(1024, 1024);
    __setRequestUrlMock(async (request) => {
      requests.push(request);
      return jsonResponse(200, {
        created: 1,
        data: [{ b64_json: b64, media_type: 'image/png' }],
        usage: { cost: 0.039 }
      });
    });

    const { vault, saved } = makeVault();
    const service = new ImageGenerationService(vault as never, settingsWithOpenRouter());

    const result = await service.generateImage({
      prompt: 'a red circle',
      provider: 'openrouter',
      model: 'gemini-2.5-flash-image',
      savePath: 'images/circle.png'
    });

    expect(result.success).toBe(true);
    expect(requests).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect(saved[0].path).toBe('images/circle.png');
    expect(Buffer.from(saved[0].bytes).toString('base64')).toBe(b64);
    expect(result.data?.imagePath).toBe('images/circle.png');
    expect(result.data?.fileSize).toBe(Buffer.from(b64, 'base64').length);
  });

  it('returns the provider error without touching the vault', async () => {
    __setRequestUrlMock(async () => jsonResponse(400, {
      error: { message: 'Black Forest Labs blocked this request: it was flagged.', code: 400 }
    }));

    const { vault, saved } = makeVault();
    const service = new ImageGenerationService(vault as never, settingsWithOpenRouter());

    const result = await service.generateImage({
      prompt: 'x',
      provider: 'openrouter',
      model: 'flux-2-pro',
      savePath: 'images/x.png'
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/blocked this request/);
    expect(saved).toHaveLength(0);
    expect(vault.createBinary).not.toHaveBeenCalled();
  });
});
