import type { App, Vault } from 'obsidian';
import { AudioGenerationService } from '../../src/services/audio/AudioGenerationService';
import { SpeechSynthesisService } from '../../src/services/readAloud/SpeechSynthesisService';
import { DEFAULT_LLM_PROVIDER_SETTINGS } from '../../src/types/llm/ProviderTypes';

type MockVault = Vault & {
  getAbstractFileByPath: jest.Mock<unknown, [string]>;
  createBinary: jest.Mock<Promise<void>, [string, ArrayBuffer]>;
  createFolder: jest.Mock<Promise<void>, [string]>;
  rename: jest.Mock<Promise<void>, [unknown, string]>;
};

function makeVault(existing: Record<string, unknown> = {}): MockVault {
  const files = new Map<string, unknown>(Object.entries(existing));
  return {
    getAbstractFileByPath: jest.fn((path: string) => files.get(path) ?? null),
    createBinary: jest.fn(async (path: string, _data: ArrayBuffer) => {
      files.set(path, { path });
    }),
    createFolder: jest.fn(async (path: string) => {
      files.set(path, { path, folder: true });
    }),
    rename: jest.fn(async (file: unknown, path: string) => {
      files.set(path, file);
    }),
  } as unknown as MockVault;
}

function makeApp(): App {
  return {
    fileManager: {
      trashFile: jest.fn().mockResolvedValue(undefined),
    }
  } as unknown as App;
}

describe('AudioGenerationService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('generates voice audio and writes it to the vault', async () => {
    jest.spyOn(SpeechSynthesisService.prototype, 'synthesize').mockResolvedValue({
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      voice: 'marin',
      audioData: new Uint8Array([1, 2, 3]).buffer,
      mimeType: 'audio/mpeg',
    });
    const vault = makeVault();
    const service = new AudioGenerationService(makeApp(), vault, {
      llmSettings: DEFAULT_LLM_PROVIDER_SETTINGS,
    });

    const result = await service.generate({
      prompt: 'Read this.',
      outputPath: 'audio/read-this.mp3',
    });

    expect(vault.createFolder).toHaveBeenCalledWith('audio');
    expect(vault.createBinary).toHaveBeenCalledWith('audio/read-this.mp3', expect.any(ArrayBuffer));
    expect(result).toMatchObject({
      path: 'audio/read-this.mp3',
      mode: 'voice',
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      voice: 'marin',
      audioSize: 3,
    });
  });

  it('refuses to overwrite an existing output unless requested', async () => {
    jest.spyOn(SpeechSynthesisService.prototype, 'synthesize').mockResolvedValue({
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      voice: 'marin',
      audioData: new ArrayBuffer(1),
      mimeType: 'audio/mpeg',
    });
    const vault = makeVault({ 'audio/existing.mp3': { path: 'audio/existing.mp3' } });
    const service = new AudioGenerationService(makeApp(), vault, {
      llmSettings: DEFAULT_LLM_PROVIDER_SETTINGS,
    });

    await expect(service.generate({
      prompt: 'Read this.',
      outputPath: 'audio/existing.mp3',
    })).rejects.toThrow('File already exists at audio/existing.mp3');

    expect(vault.createBinary).not.toHaveBeenCalled();
  });
});
