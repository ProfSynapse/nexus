import type { App, Vault } from 'obsidian';
import { TFolder, __setRequestUrlMock } from '../mocks/obsidian';
import { VideoGenerationService } from '../../src/services/video/VideoGenerationService';
import { VideoGenerationTimeoutError } from '../../src/services/video/VideoGenerationTypes';
import { GoogleVideoAdapter } from '../../src/services/video/adapters/GoogleVideoAdapter';
import { OpenRouterVideoAdapter } from '../../src/services/video/adapters/OpenRouterVideoAdapter';
import { GenerateVideoTool } from '../../src/agents/promptManager/tools/generateVideo';
import { CheckGeneratedArtifactTool } from '../../src/agents/promptManager/tools/checkGeneratedArtifact';
import { DEFAULT_LLM_PROVIDER_SETTINGS, type LLMProviderSettings } from '../../src/types/llm/ProviderTypes';

type MockVault = Vault & {
  getAbstractFileByPath: jest.Mock<unknown, [string]>;
  createBinary: jest.Mock<Promise<void>, [string, ArrayBuffer]>;
  createFolder: jest.Mock<Promise<void>, [string]>;
  rename: jest.Mock<Promise<void>, [unknown, string]>;
  adapter: {
    exists: jest.Mock<Promise<boolean>, [string]>;
    read: jest.Mock<Promise<string>, [string]>;
    append: jest.Mock<Promise<void>, [string, string]>;
    mkdir: jest.Mock<Promise<void>, [string]>;
  };
};

function makeSettings(provider: 'google' | 'openrouter'): LLMProviderSettings {
  return {
    ...DEFAULT_LLM_PROVIDER_SETTINGS,
    providers: {
      ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
      [provider]: {
        ...DEFAULT_LLM_PROVIDER_SETTINGS.providers[provider],
        apiKey: 'test-key',
        enabled: true,
      },
    },
    defaultVideoModel: provider === 'google'
      ? {
        provider: 'google',
        model: 'veo-3.1-generate-preview',
        aspectRatio: '16:9',
        resolution: '720p',
      }
      : {
        provider: 'openrouter',
        model: 'google/veo-3.1-fast',
        aspectRatio: '16:9',
        resolution: '720p',
      },
  };
}

function makeVault(existing: Record<string, unknown> = {}): MockVault {
  const files = new Map<string, unknown>(Object.entries(existing));
  const adapterFiles = new Map<string, string>();
  return {
    getAbstractFileByPath: jest.fn((path: string) => files.get(path) ?? null),
    createBinary: jest.fn(async (path: string, _data: ArrayBuffer) => {
      files.set(path, { path });
    }),
    createFolder: jest.fn(async (path: string) => {
      files.set(path, new TFolder(path));
    }),
    rename: jest.fn(async (file: unknown, path: string) => {
      files.set(path, file);
    }),
    adapter: {
      exists: jest.fn(async (path: string) => adapterFiles.has(path)),
      read: jest.fn(async (path: string) => adapterFiles.get(path) || ''),
      append: jest.fn(async (path: string, data: string) => {
        adapterFiles.set(path, `${adapterFiles.get(path) || ''}${data}`);
      }),
      mkdir: jest.fn(async (path: string) => {
        adapterFiles.set(path, adapterFiles.get(path) || '');
      }),
    },
  } as unknown as MockVault;
}

function makeApp(): App {
  return {
    fileManager: {
      trashFile: jest.fn().mockResolvedValue(undefined),
    }
  } as unknown as App;
}

describe('VideoGenerationService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('generates video and writes it to the vault', async () => {
    jest.spyOn(GoogleVideoAdapter.prototype, 'generate').mockResolvedValue({
      videoData: new Uint8Array([1, 2, 3, 4]).buffer,
      mimeType: 'video/mp4',
      providerJobId: 'operations/video-1',
      durationSeconds: 8,
    });

    const vault = makeVault();
    const service = new VideoGenerationService(makeApp(), vault, {
      llmSettings: makeSettings('google'),
    });

    const result = await service.generate({
      prompt: 'A calm ocean sunrise.',
      outputPath: 'video/sunrise.mp4',
      seconds: 8,
    });

    expect(vault.createFolder).toHaveBeenCalledWith('video');
    expect(vault.createBinary).toHaveBeenCalledWith('video/sunrise.mp4', expect.any(ArrayBuffer));
    expect(result).toMatchObject({
      status: 'completed',
      path: 'video/sunrise.mp4',
      provider: 'google',
      model: 'veo-3.1-generate-preview',
      mimeType: 'video/mp4',
      videoSize: 4,
      providerJobId: 'operations/video-1',
      note: 'Video generation completed and saved to video/sunrise.mp4.',
    });
  });

  it('refuses to overwrite an existing output unless requested', async () => {
    jest.spyOn(GoogleVideoAdapter.prototype, 'generate').mockResolvedValue({
      videoData: new ArrayBuffer(1),
      mimeType: 'video/mp4',
    });

    const vault = makeVault({
      video: new TFolder('video'),
      'video/existing.mp4': { path: 'video/existing.mp4' },
    });
    const service = new VideoGenerationService(makeApp(), vault, {
      llmSettings: makeSettings('google'),
    });

    await expect(service.generate({
      prompt: 'A calm ocean sunrise.',
      outputPath: 'video/existing.mp4',
    })).rejects.toThrow('File already exists at video/existing.mp4');

    expect(vault.createBinary).not.toHaveBeenCalled();
  });

  it('returns structured in-progress details when the tool times out', async () => {
    jest.spyOn(GoogleVideoAdapter.prototype, 'generate').mockRejectedValue(
      new VideoGenerationTimeoutError(
        'Google video generation timed out after 1 seconds. Operation name: operations/video-1.',
        {
          provider: 'google',
          model: 'veo-3.1-generate-preview',
          providerJobId: 'operations/video-1',
          pollingUrl: 'https://generativelanguage.googleapis.com/v1beta/operations/video-1',
          timeoutMs: 1000,
        }
      )
    );

    const vault = makeVault();
    const tool = new GenerateVideoTool({
      app: makeApp(),
      vault,
      llmSettings: makeSettings('google'),
    });

    const result = await tool.execute({
      prompt: 'A calm ocean sunrise.',
      outputPath: 'video/sunrise.mp4',
      timeoutMs: 1000,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('still running');
    expect(result.data).toMatchObject({
      status: 'in_progress',
      jobId: expect.stringMatching(/^artifact_/),
      path: 'video/sunrise.mp4',
      provider: 'google',
      model: 'veo-3.1-generate-preview',
      providerJobId: 'operations/video-1',
      pollingUrl: 'https://generativelanguage.googleapis.com/v1beta/operations/video-1',
      note: expect.stringContaining('video/sunrise.mp4'),
    });
    expect(vault.adapter.append).toHaveBeenCalledWith(
      'Nexus/data/artifact-jobs.jsonl',
      expect.any(String)
    );
  });

  it('checks a saved generated artifact job and saves the completed video', async () => {
    const vault = makeVault();
    jest.spyOn(GoogleVideoAdapter.prototype, 'generate').mockRejectedValue(
      new VideoGenerationTimeoutError(
        'Google video generation timed out after 1 seconds. Operation name: operations/video-2.',
        {
          provider: 'google',
          model: 'veo-3.1-generate-preview',
          providerJobId: 'operations/video-2',
          pollingUrl: 'https://generativelanguage.googleapis.com/v1beta/operations/video-2',
          timeoutMs: 1000,
          request: {
            seconds: 8,
            aspectRatio: '16:9',
            resolution: '720p',
          },
        }
      )
    );
    jest.spyOn(GoogleVideoAdapter.prototype, 'checkJob').mockResolvedValue({
      status: 'completed',
      result: {
        videoData: new Uint8Array([9, 8, 7]).buffer,
        mimeType: 'video/mp4',
        providerJobId: 'operations/video-2',
        pollingUrl: 'https://generativelanguage.googleapis.com/v1beta/operations/video-2',
        durationSeconds: 8,
      },
    });

    const generateTool = new GenerateVideoTool({
      app: makeApp(),
      vault,
      llmSettings: makeSettings('google'),
    });

    const initial = await generateTool.execute({
      prompt: 'A calm ocean sunrise.',
      outputPath: 'video/sunrise.mp4',
      timeoutMs: 1000,
    });

    const jobId = (initial.data as { jobId?: string }).jobId;
    expect(jobId).toBeTruthy();

    const checkTool = new CheckGeneratedArtifactTool({
      app: makeApp(),
      vault,
      llmSettings: makeSettings('google'),
    });
    const final = await checkTool.execute({
      jobId: jobId || '',
      pollIntervalMs: 1,
      timeoutMs: 1000,
    });

    expect(final.success).toBe(true);
    expect(final.data).toMatchObject({
      status: 'completed',
      jobId,
      path: 'video/sunrise.mp4',
      providerJobId: 'operations/video-2',
      note: 'Video generation completed and saved to video/sunrise.mp4.',
    });
    expect(vault.createBinary).toHaveBeenCalledWith('video/sunrise.mp4', expect.any(ArrayBuffer));
  });
});

describe('OpenRouterVideoAdapter', () => {
  beforeEach(() => {
    __setRequestUrlMock(async () => ({
      status: 200,
      headers: {},
      text: '{}',
      json: {},
      arrayBuffer: new ArrayBuffer(0),
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('submits, polls, and downloads a completed video job', async () => {
    const calls: string[] = [];
    __setRequestUrlMock(async (request) => {
      calls.push(request.url);

      if (request.url.endsWith('/videos/models')) {
        return {
          status: 200,
          headers: {},
          text: '{}',
          json: {
            data: [{
              id: 'google/veo-3.1-fast',
              name: 'Veo 3.1 Fast',
              supported_resolutions: ['720p'],
              supported_aspect_ratios: ['16:9'],
              supported_durations: [5],
              generate_audio: true,
            }]
          },
          arrayBuffer: new ArrayBuffer(0),
        };
      }

      if (request.url.endsWith('/videos')) {
        return {
          status: 202,
          headers: {},
          text: '{}',
          json: {
            id: 'job-1',
            status: 'queued',
            polling_url: 'https://openrouter.ai/api/v1/videos/job-1',
          },
          arrayBuffer: new ArrayBuffer(0),
        };
      }

      if (request.url.endsWith('/videos/job-1')) {
        return {
          status: 200,
          headers: {},
          text: '{}',
          json: {
            id: 'job-1',
            status: 'completed',
            unsigned_urls: ['https://cdn.example.com/video.mp4'],
          },
          arrayBuffer: new ArrayBuffer(0),
        };
      }

      return {
        status: 200,
        headers: {},
        text: '',
        json: null,
        arrayBuffer: new Uint8Array([5, 6, 7]).buffer,
      };
    });

    const adapter = new OpenRouterVideoAdapter({
      apiKey: 'test-key',
      vault: makeVault(),
    });

    const result = await adapter.generate({
      prompt: 'A calm ocean sunrise.',
      provider: 'openrouter',
      model: 'google/veo-3.1-fast',
      aspectRatio: '16:9',
      resolution: '720p',
      seconds: 5,
      pollIntervalMs: 1,
      timeoutMs: 1000,
    });

    expect(calls).toEqual([
      'https://openrouter.ai/api/v1/videos/models',
      'https://openrouter.ai/api/v1/videos',
      'https://openrouter.ai/api/v1/videos/job-1',
      'https://cdn.example.com/video.mp4',
    ]);
    expect(result.videoData.byteLength).toBe(3);
    expect(result.providerJobId).toBe('job-1');
  });

  it('rejects unsupported model options from OpenRouter metadata', async () => {
    __setRequestUrlMock(async () => ({
      status: 200,
      headers: {},
      text: '{}',
      json: {
        data: [{
          id: 'google/veo-3.1-fast',
          supported_resolutions: ['720p'],
          supported_aspect_ratios: ['16:9'],
          supported_durations: [5],
        }]
      },
      arrayBuffer: new ArrayBuffer(0),
    }));

    const adapter = new OpenRouterVideoAdapter({
      apiKey: 'test-key',
      vault: makeVault(),
    });

    await expect(adapter.generate({
      prompt: 'A calm ocean sunrise.',
      provider: 'openrouter',
      model: 'google/veo-3.1-fast',
      aspectRatio: '16:9',
      resolution: '1080p',
      seconds: 5,
      pollIntervalMs: 1,
      timeoutMs: 1000,
    })).rejects.toThrow('does not support resolution "1080p"');
  });
});
