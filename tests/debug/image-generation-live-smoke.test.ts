/**
 * Live smoke for the default image model through the shipped image adapters.
 * Paid: one 1K image per provider. Skipped unless both flags are set.
 *
 *   RUN_LIVE_IMAGE_SMOKE=1 RUN_PAID_IMAGE_SMOKE=1 \
 *     npx jest tests/debug/image-generation-live-smoke.test.ts --runInBand
 *
 * Keys come from the environment or the repo's .env: GEMINI_API_KEY (Google
 * direct) and OPENROUTER_API_KEY. A provider whose key is missing is skipped.
 */

import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { __setRequestUrlMock } from '../mocks/obsidian';
import { GeminiImageAdapter } from '../../src/services/llm/adapters/google/GeminiImageAdapter';
import { OpenRouterImageAdapter } from '../../src/services/llm/adapters/openrouter/OpenRouterImageAdapter';
import { DEFAULT_IMAGE_MODEL } from '../../src/services/llm/types/ImageTypes';

const RUN = process.env.RUN_LIVE_IMAGE_SMOKE === '1' && process.env.RUN_PAID_IMAGE_SMOKE === '1';
const describeLive = RUN ? describe : describe.skip;

function getEnv(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return undefined;
  const line = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).find(candidate => candidate.startsWith(`${name}=`));
  return line?.slice(name.length + 1).replace(/^['"]|['"]$/g, '');
}

/** Route requestUrl to the network. `trace` receives "METHOD url status" lines, never headers or keys. */
function setRealRequestUrl(trace: string[]): void {
  __setRequestUrlMock(async (request) => {
    const headers = request.headers as Record<string, string> | undefined;
    const body = typeof request.body === 'string' ? request.body : undefined;
    const response = await requestRaw(request.url, request.method || 'GET', headers, body);
    trace.push(`${request.method || 'GET'} ${request.url.replace(/([?&]key=)[^&]+/, '$1REDACTED')} ${response.status}`);
    const text = response.buffer.toString('utf8');
    const json = text.trim().startsWith('{') ? safeJson(text) : null;
    return {
      status: response.status,
      headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value ?? '')])),
      text,
      json,
      arrayBuffer: response.buffer.buffer.slice(response.buffer.byteOffset, response.buffer.byteOffset + response.buffer.byteLength),
    };
  });
}

function requestRaw(url: string, method: string, headers: Record<string, string> | undefined, body: string | undefined):
  Promise<{ status: number; headers: Record<string, string | string[] | undefined>; buffer: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, buffer: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => req.destroy(new Error('request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function expectImage(data: Buffer): void {
  const png = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = data[0] === 0xff && data[1] === 0xd8;
  const webp = data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
  expect(png || jpeg || webp).toBe(true);
  expect(data.byteLength).toBeGreaterThan(10_000);
}

describeLive('default image model live smoke', () => {
  jest.setTimeout(180_000);
  const prompt = 'A small red bicycle leaning on a white wall, flat illustration';

  it('Google direct generates with the default model and no model override', async () => {
    const apiKey = getEnv('GEMINI_API_KEY') || getEnv('GOOGLE_API_KEY');
    if (!apiKey) return;
    const trace: string[] = [];
    setRealRequestUrl(trace);
    const adapter = new GeminiImageAdapter({ apiKey });
    const result = await adapter.generateImage({ prompt, provider: 'google', imageSize: '1K', aspectRatio: '1:1', savePath: 'smoke.png' });
    console.log(`[image smoke] google ${DEFAULT_IMAGE_MODEL}: ${result.format} ${result.imageData.byteLength} bytes; ${trace.join(' | ')}`);
    expectImage(result.imageData);
  });

  it('OpenRouter generates with the default model and no model override', async () => {
    const apiKey = getEnv('OPENROUTER_API_KEY');
    if (!apiKey) return;
    const trace: string[] = [];
    setRealRequestUrl(trace);
    const adapter = new OpenRouterImageAdapter({ apiKey });
    const result = await adapter.generateImage({ prompt, provider: 'openrouter', imageSize: '1K', aspectRatio: '1:1', savePath: 'smoke.png' });
    console.log(`[image smoke] openrouter ${DEFAULT_IMAGE_MODEL}: ${result.format} ${result.imageData.byteLength} bytes; ${trace.join(' | ')}`);
    expectImage(result.imageData);
  });
});
