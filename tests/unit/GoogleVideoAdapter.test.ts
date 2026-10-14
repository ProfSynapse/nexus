/**
 * GoogleVideoAdapter: Gemini Omni Flash over the Interactions API.
 *
 * Request and response shapes follow https://ai.google.dev/gemini-api/docs/omni
 * and https://ai.google.dev/api/interactions-api. Every network call goes
 * through the obsidian requestUrl mock; no test reaches Google.
 */

import type { Vault } from 'obsidian';
import { TFile, __setRequestUrlMock } from '../mocks/obsidian';
import { GoogleVideoAdapter } from '../../src/services/video/adapters/GoogleVideoAdapter';
import { sleep, VideoGenerationAbortedError } from '../../src/services/video/adapters/videoAdapterUtils';
import {
  VideoGenerationTimeoutError,
  type PendingVideoGenerationJob,
  type ResolvedVideoGenerationRequest,
} from '../../src/services/video/VideoGenerationTypes';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
const MP4_B64 = Buffer.from(MP4).toString('base64');

interface Captured {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  arrayBuffer?: ArrayBuffer;
}

/** Route requests by "METHOD url-suffix"; unmatched requests fail the test loudly. */
function mockGoogle(routes: Record<string, Reply | Reply[] | ((request: Captured) => Reply)>): Captured[] {
  const calls: Captured[] = [];
  const queues = new Map<string, Reply[]>();
  __setRequestUrlMock(async (request) => {
    const captured: Captured = { url: request.url || '', method: request.method, headers: request.headers, body: request.body };
    calls.push(captured);
    const key = Object.keys(routes).find(candidate => {
      const [method, suffix] = candidate.split(' ');
      return (request.method || 'GET') === method && captured.url.endsWith(suffix);
    });
    if (!key) {
      throw new Error(`Unexpected request: ${request.method} ${captured.url}`);
    }
    const route = routes[key];
    let reply: Reply;
    if (typeof route === 'function') {
      reply = route(captured);
    } else if (Array.isArray(route)) {
      const queue = queues.get(key) ?? [...route];
      queues.set(key, queue);
      reply = queue.length > 1 ? queue.shift() as Reply : queue[0];
    } else {
      reply = route;
    }
    const json = reply.json;
    return {
      status: reply.status ?? 200,
      headers: {},
      text: reply.text ?? (json === undefined ? '' : JSON.stringify(json)),
      json,
      arrayBuffer: reply.arrayBuffer ?? new ArrayBuffer(0),
    };
  });
  return calls;
}

function completed(id: string, video: Record<string, unknown>, extraSteps: unknown[] = []): Reply {
  return {
    json: {
      id,
      status: 'completed',
      model: 'gemini-omni-1.1-flash',
      object: 'interaction',
      steps: [
        { type: 'user_input', content: [{ type: 'text', text: 'prompt' }] },
        { type: 'thought', content: [{ type: 'thought', text: '...' }] },
        { type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', ...video }] },
        ...extraSteps,
      ],
    },
  };
}

function request(overrides: Partial<ResolvedVideoGenerationRequest> = {}): ResolvedVideoGenerationRequest {
  return {
    prompt: 'A marble rolling fast on a chain reaction style track.',
    provider: 'google',
    model: 'gemini-omni-1.1-flash',
    aspectRatio: '16:9',
    resolution: '720p',
    pollIntervalMs: 1_000,
    timeoutMs: 60_000,
    ...overrides,
  };
}

function makeVault(files: Record<string, Uint8Array> = {}): Vault {
  return {
    getAbstractFileByPath: jest.fn((path: string) => (files[path] ? new TFile(path.split('/').pop() || path, path) : null)),
    readBinary: jest.fn(async (file: TFile) => {
      const bytes = files[file.path];
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }),
  } as unknown as Vault;
}

function adapter(vault: Vault = makeVault()): GoogleVideoAdapter {
  return new GoogleVideoAdapter({ apiKey: 'test-key', vault });
}

function body(call: Captured): Record<string, unknown> {
  return JSON.parse(call.body || '{}') as Record<string, unknown>;
}

describe('GoogleVideoAdapter (Gemini Omni Flash, Interactions API)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('request shape', () => {
    it('creates a background interaction with the documented body and the API key header', async () => {
      const calls = mockGoogle({
        'POST /interactions': { json: { id: 'v1_a', status: 'in_progress' } },
        'GET /interactions/v1_a': completed('v1_a', { data: MP4_B64 }),
      });

      const run = adapter().generate(request({ aspectRatio: '9:16', resolution: '1080p', seconds: 8 }));
      await jest.advanceTimersByTimeAsync(1_000);
      await run;

      expect(calls[0].url).toBe(`${BASE}/interactions`);
      expect(calls[0].method).toBe('POST');
      expect(calls[0].headers).toEqual({ 'Content-Type': 'application/json', 'x-goog-api-key': 'test-key' });
      expect(calls[0].url).not.toContain('key=');
      expect(body(calls[0])).toEqual({
        model: 'gemini-omni-1.1-flash',
        input: 'A marble rolling fast on a chain reaction style track.',
        response_format: { type: 'video', aspect_ratio: '9:16', resolution: '1080p', duration: '8s' },
        background: true,
      });
    });

    it('omits duration when no length is requested, so the model picks one', async () => {
      const calls = mockGoogle({ 'POST /interactions': completed('v1_b', { data: MP4_B64 }) });

      await adapter().generate(request());

      expect(body(calls[0]).response_format).toEqual({ type: 'video', aspect_ratio: '16:9', resolution: '720p' });
    });

    it('sends a reference image as an inline image part ahead of the text part', async () => {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const calls = mockGoogle({ 'POST /interactions': completed('v1_c', { data: MP4_B64 }) });

      await adapter(makeVault({ 'refs/fish.png': png })).generate(request({ referenceImage: 'refs/fish.png', prompt: 'Make it swim.' }));

      expect(body(calls[0]).input).toEqual([
        { type: 'image', data: Buffer.from(png).toString('base64'), mime_type: 'image/png' },
        { type: 'text', text: 'Make it swim.' },
      ]);
    });

    it('folds a negative prompt into the prompt, since Omni has no negative-prompt field', async () => {
      const calls = mockGoogle({ 'POST /interactions': completed('v1_d', { data: MP4_B64 }) });

      await adapter().generate(request({ prompt: 'A beach at dusk.', negativePrompt: 'people, text' }));

      const sent = body(calls[0]);
      expect(sent.input).toBe('A beach at dusk.\n\nDo not include: people, text');
      expect(sent).not.toHaveProperty('negative_prompt');
      expect(sent).not.toHaveProperty('negativePrompt');
    });

    it('rejects generateAudio: false before calling Google, because Omni always renders audio', async () => {
      const calls = mockGoogle({});

      await expect(adapter().generate(request({ generateAudio: false }))).rejects.toThrow(/always generates audio/);
      expect(calls).toHaveLength(0);
    });

    it.each([2, 11, 7.5])('rejects a %s-second clip before calling Google', async (seconds) => {
      const calls = mockGoogle({});

      await expect(adapter().generate(request({ seconds }))).rejects.toThrow(/Use 3-10 seconds/);
      expect(calls).toHaveLength(0);
    });

    it('retries without background when Google rejects background mode for the model', async () => {
      const calls = mockGoogle({
        'POST /interactions': [
          { status: 400, json: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'background is not supported for this model' } } },
          completed('v1_sync', { data: MP4_B64 }),
        ],
      });

      const result = await adapter().generate(request());

      expect(calls).toHaveLength(2);
      expect(body(calls[0]).background).toBe(true);
      expect(body(calls[1])).not.toHaveProperty('background');
      expect(result.providerJobId).toBe('v1_sync');
    });
  });

  describe('polling and download', () => {
    it('polls until completed, decodes the inline MP4 and leaves no timer behind', async () => {
      const calls = mockGoogle({
        'POST /interactions': { json: { id: 'v1_p', status: 'in_progress' } },
        'GET /interactions/v1_p': [
          { json: { id: 'v1_p', status: 'queued' } },
          { json: { id: 'v1_p', status: 'in_progress' } },
          completed('v1_p', { data: MP4_B64 }),
        ],
      });

      const run = adapter().generate(request({ seconds: 5 }));
      await jest.advanceTimersByTimeAsync(3_000);
      const result = await run;

      expect(calls.filter(call => call.method === 'GET')).toHaveLength(3);
      expect(calls[1].headers).toEqual({ 'x-goog-api-key': 'test-key' });
      expect(Array.from(new Uint8Array(result.videoData))).toEqual(Array.from(MP4));
      expect(result).toMatchObject({
        mimeType: 'video/mp4',
        providerJobId: 'v1_p',
        pollingUrl: `${BASE}/interactions/v1_p`,
        durationSeconds: 5,
      });
      expect(jest.getTimerCount()).toBe(0);
    });

    it('reads a top-level output_video too, as the guide\'s URI sample does', async () => {
      mockGoogle({ 'POST /interactions': { json: { id: 'v1_o', status: 'completed', output_video: { data: MP4_B64 } } } });

      const result = await adapter().generate(request());

      expect(Array.from(new Uint8Array(result.videoData))).toEqual(Array.from(MP4));
    });

    it('waits for a Files API URI to become ACTIVE, then downloads it with the key', async () => {
      const uri = `${BASE}/files/abc123:download?alt=media`;
      const calls = mockGoogle({
        'POST /interactions': completed('v1_u', { uri }),
        'GET /files/abc123': [{ json: { name: 'files/abc123', state: 'PROCESSING' } }, { json: { name: 'files/abc123', state: 'ACTIVE' } }],
        'GET /files/abc123:download?alt=media': { arrayBuffer: MP4.buffer.slice(0) },
      });

      const run = adapter().generate(request());
      await jest.advanceTimersByTimeAsync(1_000);
      const result = await run;

      const download = calls.find(call => call.url === uri);
      expect(download?.headers).toEqual({ 'x-goog-api-key': 'test-key' });
      expect(calls.filter(call => call.url === `${BASE}/files/abc123`)).toHaveLength(2);
      expect(Array.from(new Uint8Array(result.videoData))).toEqual(Array.from(MP4));
      expect(jest.getTimerCount()).toBe(0);
    });

    it('accepts a relative files/<id> URI', async () => {
      const calls = mockGoogle({
        'POST /interactions': completed('v1_r', { uri: 'files/rel-1' }),
        'GET /files/rel-1': { json: { state: 'ACTIVE' } },
        'GET /files/rel-1:download?alt=media': { arrayBuffer: MP4.buffer.slice(0) },
      });

      await adapter().generate(request());

      expect(calls.map(call => call.url)).toContain(`${BASE}/files/rel-1:download?alt=media`);
    });

    it('does not send the API key to a download host off the allowlist', async () => {
      const calls = mockGoogle({
        'POST /interactions': completed('v1_x', { uri: 'https://evil.example.com/steal.mp4' }),
        'GET /steal.mp4': { arrayBuffer: MP4.buffer.slice(0) },
      });

      await adapter().generate(request());

      expect(calls.find(call => call.url === 'https://evil.example.com/steal.mp4')?.headers).toBeUndefined();
    });

    it('does not send the API key to a userinfo-trick URI', async () => {
      const trick = 'https://generativelanguage.googleapis.com@evil.com/files/abc:download?alt=media';
      const calls = mockGoogle({
        'POST /interactions': completed('v1_t', { uri: trick }),
        'GET /files/abc:download?alt=media': { arrayBuffer: MP4.buffer.slice(0) },
      });

      await adapter().generate(request());

      expect(calls.every(call => !call.url.startsWith('https://generativelanguage.googleapis.com/') || call.method === 'POST')).toBe(true);
      expect(calls.find(call => call.url === trick)?.headers).toBeUndefined();
    });

    it('ignores a video placed outside the model_output step', async () => {
      mockGoogle({
        'POST /interactions': {
          json: {
            id: 'v1_h',
            status: 'completed',
            steps: [{ type: 'user_input', content: [{ type: 'video', uri: 'https://evil.example.com/x.mp4' }] }],
          },
        },
      });

      await expect(adapter().generate(request())).rejects.toThrow(/returned no video/);
    });
  });

  describe('errors', () => {
    it('reports a safety block when the interaction fails with content_blocked', async () => {
      mockGoogle({
        'POST /interactions': { json: { id: 'v1_s', status: 'in_progress' } },
        'GET /interactions/v1_s': { json: { id: 'v1_s', status: 'failed', errors: [{ code: 'content_blocked', message: 'The prompt was blocked.' }] } },
      });

      const run = adapter().generate(request());
      const assertion = expect(run).rejects.toThrow(/Google blocked this video request under its safety or usage policies \(content_blocked: The prompt was blocked\.\)/);
      await jest.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(jest.getTimerCount()).toBe(0);
    });

    it('reports a safety block when the create call is rejected with HTTP 400 content_blocked', async () => {
      mockGoogle({ 'POST /interactions': { status: 400, json: { error: { code: 'content_blocked', message: 'Request blocked.' } } } });

      await expect(adapter().generate(request())).rejects.toThrow(/safety or usage policies \(Request blocked\.\)/);
    });

    it('reports a quota error on HTTP 429', async () => {
      mockGoogle({ 'POST /interactions': { status: 429, json: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded.' } } } });

      await expect(adapter().generate(request())).rejects.toThrow(/quota or rate limit \(Quota exceeded\.\).*paid tier only/);
    });

    it('names the supported options when Google rejects one with HTTP 400', async () => {
      mockGoogle({ 'POST /interactions': { status: 400, json: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Invalid value at response_format.resolution' } } } });

      await expect(adapter().generate(request())).rejects.toThrow(
        /rejected an option in the video request \(HTTP 400\): Invalid value at response_format\.resolution\. Gemini Omni Flash accepts aspect ratio 16:9 or 9:16/
      );
    });

    it('explains an API key or access problem on HTTP 403', async () => {
      mockGoogle({ 'POST /interactions': { status: 403, json: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Not allowed.' } } } });

      await expect(adapter().generate(request())).rejects.toThrow(/rejected the API key for video generation \(HTTP 403\)/);
    });

    it('survives an error body that is not JSON', async () => {
      mockGoogle({ 'POST /interactions': { status: 502, text: '<html>Bad gateway</html>' } });

      await expect(adapter().generate(request())).rejects.toThrow(/Google video generation failed \(HTTP 502\): <html>Bad gateway<\/html>/);
    });

    it('passes on what the model said when it completes without a video', async () => {
      mockGoogle({
        'POST /interactions': {
          json: { id: 'v1_n', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'I cannot make that video.' }] }] },
        },
      });

      await expect(adapter().generate(request())).rejects.toThrow(/returned no video for "gemini-omni-1.1-flash".*The model said: "I cannot make that video\."/);
    });
  });

  describe('timeout and abort', () => {
    it('times out with the interaction id so the job can be finished later, and clears its timer', async () => {
      mockGoogle({
        'POST /interactions': { json: { id: 'v1_slow', status: 'in_progress' } },
        'GET /interactions/v1_slow': { json: { id: 'v1_slow', status: 'in_progress' } },
      });

      const run = adapter().generate(request({ timeoutMs: 3_000, seconds: 6 }));
      const settled = run.catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(5_000);
      const error = await settled;

      expect(error).toBeInstanceOf(VideoGenerationTimeoutError);
      expect((error as VideoGenerationTimeoutError).details).toMatchObject({
        provider: 'google',
        model: 'gemini-omni-1.1-flash',
        providerJobId: 'v1_slow',
        pollingUrl: `${BASE}/interactions/v1_slow`,
        timeoutMs: 3_000,
        request: { seconds: 6, aspectRatio: '16:9', resolution: '720p' },
      });
      expect(jest.getTimerCount()).toBe(0);
    });

    it('stops polling on abort, asks Google to cancel, and leaves no timer behind', async () => {
      const calls = mockGoogle({
        'POST /interactions': { json: { id: 'v1_ab', status: 'in_progress' } },
        'GET /interactions/v1_ab': { json: { id: 'v1_ab', status: 'in_progress' } },
        'POST /interactions/v1_ab/cancel': { json: { id: 'v1_ab', status: 'cancelled' } },
      });
      const controller = new AbortController();

      const run = adapter().generate(request({ signal: controller.signal }));
      const settled = run.catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(1_500);
      controller.abort();
      const error = await settled;

      expect(error).toBeInstanceOf(VideoGenerationAbortedError);
      expect(calls.some(call => call.method === 'POST' && call.url === `${BASE}/interactions/v1_ab/cancel`)).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('does not call Google at all when already aborted', async () => {
      const calls = mockGoogle({});
      const controller = new AbortController();
      controller.abort();

      await expect(adapter().generate(request({ signal: controller.signal }))).rejects.toBeInstanceOf(VideoGenerationAbortedError);
      expect(calls).toHaveLength(0);
    });
  });

  describe('checkJob', () => {
    function job(providerJobId: string): PendingVideoGenerationJob {
      return {
        provider: 'google',
        model: 'gemini-omni-1.1-flash',
        outputPath: 'video/out.mp4',
        providerJobId,
        request: { seconds: 8, aspectRatio: '16:9', resolution: '720p' },
      };
    }

    it('reports in_progress while the interaction runs', async () => {
      mockGoogle({ 'GET /interactions/v1_j': { json: { id: 'v1_j', status: 'in_progress' } } });

      await expect(adapter().checkJob(job('v1_j'))).resolves.toEqual({
        status: 'in_progress',
        providerJobId: 'v1_j',
        pollingUrl: `${BASE}/interactions/v1_j`,
      });
    });

    it('returns the video once the interaction completes', async () => {
      mockGoogle({ 'GET /interactions/v1_j': completed('v1_j', { data: MP4_B64 }) });

      const check = await adapter().checkJob(job('v1_j'));

      expect(check.status).toBe('completed');
      if (check.status === 'completed') {
        expect(Array.from(new Uint8Array(check.result.videoData))).toEqual(Array.from(MP4));
        expect(check.result.durationSeconds).toBe(8);
      }
    });

    it('reports a still-processing output file as in_progress instead of waiting', async () => {
      mockGoogle({
        'GET /interactions/v1_j': completed('v1_j', { uri: 'files/f1' }),
        'GET /files/f1': { json: { state: 'PROCESSING' } },
      });

      await expect(adapter().checkJob(job('v1_j'))).resolves.toMatchObject({ status: 'in_progress' });
      expect(jest.getTimerCount()).toBe(0);
    });

    it('reports a failed interaction as failed with a mapped message', async () => {
      mockGoogle({ 'GET /interactions/v1_j': { json: { id: 'v1_j', status: 'failed', errors: [{ code: 'resource_exhausted', message: 'Out of quota.' }] } } });

      await expect(adapter().checkJob(job('v1_j'))).resolves.toMatchObject({
        status: 'failed',
        error: expect.stringMatching(/quota or rate limit/),
      });
    });

    it('fails a job left over from the retired Veo preview path without polling it', async () => {
      const calls = mockGoogle({});

      const check = await adapter().checkJob(job('models/veo-3.1-generate-preview/operations/abc'));

      expect(calls).toHaveLength(0);
      expect(check).toMatchObject({ status: 'failed', error: expect.stringMatching(/Veo 3\.1 preview.*gemini-omni-1\.1-flash/) });
    });
  });
});

describe('sleep', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('resolves after the delay and removes its abort listener', async () => {
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');

    const wait = sleep(1_000, controller.signal);
    await jest.advanceTimersByTimeAsync(1_000);
    await wait;

    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects on abort and clears its timer', async () => {
    const controller = new AbortController();

    const wait = sleep(60_000, controller.signal);
    controller.abort();

    await expect(wait).rejects.toBeInstanceOf(VideoGenerationAbortedError);
    expect(jest.getTimerCount()).toBe(0);
  });
});
