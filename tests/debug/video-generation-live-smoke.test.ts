/**
 * Live smoke for PromptManager generateVideo.
 *
 * Default:
 *   RUN_LIVE_VIDEO_SMOKE=1 npx jest tests/debug/video-generation-live-smoke.test.ts --runInBand
 *
 * Paid generation:
 *   RUN_LIVE_VIDEO_SMOKE=1 RUN_PAID_VIDEO_SMOKE=1 npx jest tests/debug/video-generation-live-smoke.test.ts --runInBand
 */

import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import type { App, Vault } from 'obsidian';
import { TFolder, __setRequestUrlMock } from '../mocks/obsidian';
import { GenerateVideoTool } from '../../src/agents/promptManager/tools/generateVideo';
import { DEFAULT_LLM_PROVIDER_SETTINGS, type LLMProviderSettings } from '../../src/types/llm/ProviderTypes';

const RUN_LIVE = process.env.RUN_LIVE_VIDEO_SMOKE === '1';
const RUN_PAID = process.env.RUN_PAID_VIDEO_SMOKE === '1';

const describeLive = RUN_LIVE ? describe : describe.skip;

type MockVault = Vault & {
  getAbstractFileByPath: jest.Mock<unknown, [string]>;
  createBinary: jest.Mock<Promise<void>, [string, ArrayBuffer]>;
  createFolder: jest.Mock<Promise<void>, [string]>;
  rename: jest.Mock<Promise<void>, [unknown, string]>;
  readBinary: jest.Mock<Promise<ArrayBuffer>, [unknown]>;
  adapter: {
    exists: jest.Mock<Promise<boolean>, [string]>;
    read: jest.Mock<Promise<string>, [string]>;
    append: jest.Mock<Promise<void>, [string, string]>;
    mkdir: jest.Mock<Promise<void>, [string]>;
  };
};

function getEnv(name: string): string | undefined {
  if (process.env[name]) {
    return process.env[name];
  }

  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    return undefined;
  }

  const line = fs.readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .find(candidate => candidate.startsWith(`${name}=`));
  return line?.slice(name.length + 1).replace(/^['"]|['"]$/g, '');
}

function makeSettings(): LLMProviderSettings {
  return {
    ...DEFAULT_LLM_PROVIDER_SETTINGS,
    providers: {
      ...DEFAULT_LLM_PROVIDER_SETTINGS.providers,
      openrouter: {
        ...DEFAULT_LLM_PROVIDER_SETTINGS.providers.openrouter,
        apiKey: getEnv('OPENROUTER_API_KEY') || '',
        enabled: true,
      },
    },
    defaultVideoModel: {
      provider: 'openrouter',
      model: 'google/veo-3.1-lite',
      aspectRatio: '16:9',
      resolution: '720p',
    },
  };
}

function makeFileBackedVault(root: string): MockVault {
  const entries = new Map<string, unknown>();

  return {
    getAbstractFileByPath: jest.fn((vaultPath: string) => entries.get(vaultPath) ?? null),
    createFolder: jest.fn(async (vaultPath: string) => {
      fs.mkdirSync(path.join(root, vaultPath), { recursive: true });
      entries.set(vaultPath, new TFolder(vaultPath));
    }),
    createBinary: jest.fn(async (vaultPath: string, data: ArrayBuffer) => {
      const outputPath = path.join(root, vaultPath);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, Buffer.from(data));
      entries.set(vaultPath, { path: vaultPath });
    }),
    rename: jest.fn(async (file: unknown, vaultPath: string) => {
      entries.set(vaultPath, file);
    }),
    readBinary: jest.fn(async () => new ArrayBuffer(0)),
    adapter: {
      exists: jest.fn(async (vaultPath: string) => fs.existsSync(path.join(root, vaultPath))),
      read: jest.fn(async (vaultPath: string) => fs.existsSync(path.join(root, vaultPath)) ? fs.readFileSync(path.join(root, vaultPath), 'utf8') : ''),
      append: jest.fn(async (vaultPath: string, data: string) => {
        const outputPath = path.join(root, vaultPath);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.appendFileSync(outputPath, data);
      }),
      mkdir: jest.fn(async (vaultPath: string) => {
        fs.mkdirSync(path.join(root, vaultPath), { recursive: true });
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

function setRealRequestUrl(): void {
  __setRequestUrlMock(async (request) => {
    const headers = request.headers as Record<string, string> | undefined;
    const body = typeof request.body === 'string' ? request.body : undefined;
    const response = await requestRaw(request.url, request.method || 'GET', headers, body);
    const text = response.buffer.toString('utf8');
    const contentType = response.headers['content-type'] || '';
    const json = contentType.includes('application/json') || text.trim().startsWith('{')
      ? safeJson(text)
      : null;
    return {
      status: response.status,
      headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value ?? '')])),
      text,
      json,
      arrayBuffer: response.buffer.buffer.slice(response.buffer.byteOffset, response.buffer.byteOffset + response.buffer.byteLength),
    };
  });
}

function requestRaw(
  url: string,
  method: string,
  headers: Record<string, string> | undefined,
  body: string | undefined
): Promise<{ status: number; headers: https.IncomingHttpHeaders; buffer: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          buffer: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error('request timeout')));
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

describeLive('generateVideo live smoke', () => {
  jest.setTimeout(10 * 60_000);

  it('returns recoverable job details when polling times out', async () => {
    __setRequestUrlMock(async (request) => {
      if (request.url.endsWith('/videos/models')) {
        return {
          status: 200,
          headers: {},
          text: '{}',
          json: {
            data: [{
              id: 'google/veo-3.1-lite',
              supported_resolutions: ['720p'],
              supported_aspect_ratios: ['16:9'],
              supported_durations: [4],
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
            id: 'job-timeout-smoke',
            status: 'queued',
            polling_url: 'https://openrouter.ai/api/v1/videos/job-timeout-smoke',
          },
          arrayBuffer: new ArrayBuffer(0),
        };
      }

      return {
        status: 200,
        headers: {},
        text: '{}',
        json: {
          id: 'job-timeout-smoke',
          status: 'queued',
          polling_url: 'https://openrouter.ai/api/v1/videos/job-timeout-smoke',
        },
        arrayBuffer: new ArrayBuffer(0),
      };
    });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-video-timeout-'));
    const tool = new GenerateVideoTool({
      app: makeApp(),
      vault: makeFileBackedVault(root),
      llmSettings: makeSettings(),
    });

    const result = await tool.execute({
      prompt: 'A quiet mountain lake at sunrise.',
      provider: 'openrouter',
      model: 'google/veo-3.1-lite',
      outputPath: 'video/timeout-smoke.mp4',
      aspectRatio: '16:9',
      resolution: '720p',
      seconds: 4,
      pollIntervalMs: 1,
      timeoutMs: 1,
      generateAudio: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
    expect(result.error).toContain('job-timeout-smoke');
    expect(result.data).toMatchObject({
      status: 'in_progress',
      jobId: expect.stringMatching(/^artifact_/),
      path: 'video/timeout-smoke.mp4',
    });
  });

  it('generates and saves a real short OpenRouter video when paid smoke is enabled', async () => {
    if (!RUN_PAID) {
      console.log('Skipping paid video generation. Set RUN_PAID_VIDEO_SMOKE=1 to enable.');
      return;
    }

    const apiKey = getEnv('OPENROUTER_API_KEY');
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY is required for paid video smoke.');
    }

    setRealRequestUrl();

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-video-live-'));
    const tool = new GenerateVideoTool({
      app: makeApp(),
      vault: makeFileBackedVault(root),
      llmSettings: makeSettings(),
    });

    const result = await tool.execute({
      prompt: 'A four second cinematic shot of a small glass prism on a desk splitting morning sunlight into a rainbow. Static camera, realistic, no text.',
      provider: 'openrouter',
      model: 'google/veo-3.1-lite',
      outputPath: 'video/openrouter-video-smoke.mp4',
      aspectRatio: '16:9',
      resolution: '720p',
      seconds: 4,
      pollIntervalMs: 10_000,
      timeoutMs: 8 * 60_000,
      generateAudio: false,
    });

    if (!result.success) {
      throw new Error(result.error || 'generateVideo tool returned failure without an error message.');
    }

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      path: 'video/openrouter-video-smoke.mp4',
      provider: 'openrouter',
      model: 'google/veo-3.1-lite',
      mimeType: 'video/mp4',
    });

    const outputPath = path.join(root, 'video/openrouter-video-smoke.mp4');
    const stat = fs.statSync(outputPath);
    expect(stat.size).toBeGreaterThan(1000);
    console.log(`Generated video smoke artifact: ${outputPath}`);
  });
});
