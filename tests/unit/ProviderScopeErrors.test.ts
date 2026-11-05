/**
 * Bare requestUrl throws on non-2xx and discards the body, so a key missing a
 * permission surfaced as "Request failed, status 401". Tools now report the
 * provider's explanation, and name the missing permission when there is one.
 * Bodies below are verbatim from the providers unless noted.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';
import { describeProviderHttpFailure, findMissingPermission } from '../../src/services/llm/adapters/shared/ProviderErrorMessages';
import { ProviderHttpClient, ProviderHttpError, providerErrorDetail } from '../../src/services/llm/adapters/shared/ProviderHttpClient';
import { SoundEffectsTool } from '../../src/agents/apps/elevenlabs/tools/soundEffects';
import { MusicGenerationTool } from '../../src/agents/apps/elevenlabs/tools/musicGeneration';
import { ListVoicesTool } from '../../src/agents/apps/elevenlabs/tools/listVoices';
import { ElevenLabsSpeechAdapter } from '../../src/services/readAloud/ElevenLabsSpeechAdapter';
import { OpenAISpeechAdapter } from '../../src/services/readAloud/OpenAISpeechAdapter';
import { GoogleSpeechAdapter } from '../../src/services/readAloud/GoogleSpeechAdapter';
import { OpenRouterSpeechAdapter } from '../../src/services/readAloud/OpenRouterSpeechAdapter';
import { getSpeechModel, getSpeechModelsForProvider, getSpeechOutputExtension } from '../../src/services/llm/types/SpeechTypes';
import { SpeechModelCatalogService } from '../../src/services/readAloud/SpeechModelCatalogService';
import { DEFAULT_LLM_PROVIDER_SETTINGS } from '../../src/types/llm/ProviderTypes';

// Verbatim from ElevenLabs for a key without the scope (GET /v1/user, HTTP 401), naming text_to_speech instead of user_read.
const ELEVENLABS_MISSING = { detail: { type: 'authentication_error', code: 'unauthorized', message: 'The API key you used is missing the permission text_to_speech to execute this operation.', status: 'missing_permissions', request_id: 'x' } };
// OpenAI's documented wording for a restricted key.
const OPENAI_MISSING = { error: { message: "You have insufficient permissions for this operation. Missing scopes: api.model.audio.request. Check that you have the correct role in your organization.", type: 'insufficient_permissions' } };

function respondWith(status: number, json: unknown) {
  __setRequestUrlMock(async () => ({ status, headers: {}, text: JSON.stringify(json), json, arrayBuffer: new ArrayBuffer(0) }) as never);
}

describe('finding a missing permission', () => {
  it.each([
    [401, ELEVENLABS_MISSING.detail.message, 'text_to_speech'],
    [401, OPENAI_MISSING.error.message, 'api.model.audio.request'],
    [403, 'Request had insufficient authentication scopes.', ''],
    [403, 'PERMISSION_DENIED: the caller does not have permission', ''],
    [403, 'This key lacks the required permission.', ''],
  ])('HTTP %i: %s', (status, detail, expected) => {
    expect(findMissingPermission(status, detail)).toBe(expected);
  });

  it.each([
    [401, "Incorrect API key provided: bad. You can find your API key at https://platform.openai.com/account/api-keys."],
    [401, 'Missing Authentication header'],
    [401, ''],
    [403, 'This model is not available in your region.'],
    // A permission word in a non-auth failure is not a scope problem.
    [400, 'The prompt mentions missing permissions'],
    [500, 'insufficient permissions backend'],
  ])('does not misread HTTP %i: %s', (status, detail) => {
    expect(findMissingPermission(status, detail)).toBeNull();
  });
});

describe('the sentence a person reads', () => {
  it('says the key is fine and names the permission, instead of blaming the key', () => {
    const message = describeProviderHttpFailure('elevenlabs', 401, ELEVENLABS_MISSING.detail.message);
    expect(message).toContain('ElevenLabs accepted the API key');
    expect(message).toContain('text_to_speech');
    expect(message).not.toContain('did not accept');
  });

  it('still says a wrong key is wrong, and points to the right settings tab', () => {
    expect(describeProviderHttpFailure('openai', 401, 'Incorrect API key provided')).toContain('Check it in Nexus settings under Providers');
    expect(describeProviderHttpFailure('elevenlabs', 401, 'bad key')).toContain('under Apps');
  });

  it('uses the provider name for image adapters too', () => {
    expect(describeProviderHttpFailure('openai-image', 403, OPENAI_MISSING.error.message)).toMatch(/^OpenAI accepted the API key/);
  });

  it('reads ElevenLabs bodies, which nest the message under detail', () => {
    expect(providerErrorDetail({ json: ELEVENLABS_MISSING, data: null })).toBe(ELEVENLABS_MISSING.detail.message);
    expect(providerErrorDetail({ json: { detail: 'plain text' }, data: null })).toBe('plain text');
  });
});

describe('requestOk', () => {
  it('throws the readable error with the body, because it asks requestUrl not to throw', async () => {
    let sentThrow: unknown;
    __setRequestUrlMock(async (request: { throw?: boolean }) => {
      sentThrow = request.throw;
      return { status: 401, headers: {}, text: JSON.stringify(ELEVENLABS_MISSING), json: ELEVENLABS_MISSING, arrayBuffer: new ArrayBuffer(0) } as never;
    });
    await expect(ProviderHttpClient.requestOk({ url: 'https://x.test/a', provider: 'elevenlabs', operation: 'speech' })).rejects.toThrow(/missing the text_to_speech permission/);
    expect(sentThrow).toBe(false);
  });

  it('does not decode a media body, whose json getter would throw', async () => {
    const audio = new ArrayBuffer(4);
    __setRequestUrlMock(async () => ({
      status: 200, headers: {}, arrayBuffer: audio,
      get text(): string { throw new Error('binary'); },
      get json(): unknown { throw new Error('binary'); },
    }) as never);
    const response = await ProviderHttpClient.requestOk({ url: 'https://x.test/a', provider: 'openai', operation: 'speech', responseType: 'binary' });
    expect(response.arrayBuffer).toBe(audio);
  });

  it('keeps the status when an error page is not JSON', async () => {
    __setRequestUrlMock(async () => ({
      status: 502, headers: {}, text: '<html>Bad Gateway</html>', arrayBuffer: new ArrayBuffer(0),
      get json(): unknown { throw new SyntaxError('Unexpected token <'); },
    }) as never);
    await expect(ProviderHttpClient.requestOk({ url: 'https://x.test/a', provider: 'openrouter', operation: 'speech' })).rejects.toMatchObject({ name: 'ProviderHttpError', response: { status: 502 } });
  });
});

describe('tools report it back', () => {
  const vault = { getAbstractFileByPath: () => null, createFolder: async () => undefined, createBinary: async () => undefined };
  const agent = { hasRequiredCredentials: () => true, getMissingCredentials: () => [], getCredential: () => 'key', getVault: () => vault };
  const request = (provider: string, model: string) => ({ text: 'hi', provider, model, voice: 'v' }) as never;

  it.each([
    ['sound effects', () => new SoundEffectsTool(agent as never).execute({ prompt: 'rain', outputPath: 'a.mp3' } as never)],
    ['music', () => new MusicGenerationTool(agent as never).execute({ prompt: 'jazz', outputPath: 'a.mp3' } as never)],
    ['voices', () => new ListVoicesTool(agent as never).execute({} as never)],
  ])('%s', async (_label, run) => {
    respondWith(401, ELEVENLABS_MISSING);
    const result = await run() as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('missing the text_to_speech permission');
    expect(result.error).not.toContain('Request failed');
  });

  it.each([
    ['elevenlabs', 'eleven_multilingual_v2', () => new ElevenLabsSpeechAdapter({ apiKey: 'k' })],
    ['openai', 'tts-1', () => new OpenAISpeechAdapter({ apiKey: 'k' })],
    ['google', 'gemini-3.8-flash-tts', () => new GoogleSpeechAdapter({ apiKey: 'k' })],
    ['openrouter', 'deepgram/aura-2', () => new OpenRouterSpeechAdapter({ apiKey: 'k' })],
  ])('%s speech', async (provider, model, make) => {
    respondWith(403, OPENAI_MISSING);
    await expect(make().synthesize(request(provider, model))).rejects.toThrow(/missing the api\.model\.audio\.request permission/);
  });

  it('a provider rejection is a typed error callers can inspect', async () => {
    respondWith(401, ELEVENLABS_MISSING);
    await expect(new ElevenLabsSpeechAdapter({ apiKey: 'k' }).synthesize(request('elevenlabs', 'eleven_v4'))).rejects.toBeInstanceOf(ProviderHttpError);
  });
});

describe('OpenRouter speech', () => {
  function capture(respond: (body: Record<string, unknown>) => unknown) {
    const bodies: Array<Record<string, unknown>> = [];
    __setRequestUrlMock(async (request: { body?: string }) => {
      const body = JSON.parse(String(request.body));
      bodies.push(body);
      return respond(body) as never;
    });
    return bodies;
  }
  const mp3 = () => ({ status: 200, headers: { 'content-type': 'audio/mpeg' }, text: '', json: null, arrayBuffer: new ArrayBuffer(8) });
  const pcm = (rate = 24000) => ({ status: 200, headers: { 'content-type': `audio/pcm;rate=${rate};channels=1` }, text: '', json: null, arrayBuffer: new ArrayBuffer(8) });
  const adapter = () => new OpenRouterSpeechAdapter({ apiKey: 'k' });
  const go = (model: string, voice = 'v') => adapter().synthesize({ text: 'hi', provider: 'openrouter', model, voice } as never);

  it('declares every shipped model with a voice from its own list, never one from another provider', () => {
    const models = getSpeechModelsForProvider('openrouter');
    expect(models.map(model => model.id)).toEqual(expect.arrayContaining(['elevenlabs/eleven-v4', 'elevenlabs/eleven-flash-v2.5', 'google/gemini-3.8-flash-tts', 'x-ai/grok-voice-tts-1.0']));
    for (const model of models) expect(model.defaultVoice).not.toBe('alloy');
    expect(getSpeechModel('openrouter', 'elevenlabs/eleven-v4')?.defaultVoice).toBe('sarah');
    expect(getSpeechModel('openrouter', 'google/gemini-3.8-flash-tts')?.defaultVoice).toBe('Kore');
  });

  it('leaves out what is shutting down', () => {
    for (const id of ['google/gemini-3.1-flash-tts-preview', 'heygen/heygen-voice-1-turbo:free', 'microsoft/mai-voice-2', 'openai/gpt-4o-mini-tts-2025-12-15']) {
      expect(getSpeechModel('openrouter', id)).toBeUndefined();
    }
  });

  it('keeps a voice known to fit first, for setups with no chosen model', () => {
    expect(getSpeechModelsForProvider('openrouter')[0]).toMatchObject({ id: 'deepgram/aura-2', defaultVoice: 'aura-2-thalia-en' });
  });

  it('asks for MP3 where a model has it', async () => {
    const bodies = capture(mp3);
    const result = await go('elevenlabs/eleven-v4', 'sarah');
    expect(bodies[0]).toMatchObject({ response_format: 'mp3', voice: 'sarah' });
    expect(result.mimeType).toBe('audio/mpeg');
    expect(getSpeechOutputExtension('openrouter', 'elevenlabs/eleven-v4')).toBe('mp3');
  });

  it.each(['google/gemini-3.8-flash-tts', 'heygen/heygen-voice-1', 'mistralai/voxtral-mini-tts-3-0'])('asks %s for PCM and wraps it as WAV', async id => {
    const bodies = capture(() => pcm());
    const result = await go(id);
    expect(bodies[0].response_format).toBe('pcm');
    expect(result.mimeType).toBe('audio/wav');
    expect(Buffer.from(result.audioData).subarray(0, 4).toString()).toBe('RIFF');
    expect(getSpeechOutputExtension('openrouter', id)).toBe('wav');
  });

  it('writes the sample rate the response declares, because HeyGen differs from Gemini', async () => {
    capture(() => pcm(44100));
    const result = await go('heygen/heygen-voice-1');
    expect(new DataView(result.audioData).getUint32(24, true)).toBe(44100);
  });

  it('falls back to PCM once for a model the catalog has not met', async () => {
    const bodies = capture(body => body.response_format === 'mp3'
      ? { status: 400, headers: {}, text: '{}', json: { error: { message: 'Brand X only supports response_format "pcm".' } }, arrayBuffer: new ArrayBuffer(0) }
      : pcm());
    const result = await go('brandx/new-tts');
    expect(bodies.map(body => body.response_format)).toEqual(['mp3', 'pcm']);
    expect(result.mimeType).toBe('audio/wav');
  });

  it('does not retry an unrelated rejection, which would bill twice', async () => {
    const bodies = capture(() => ({ status: 400, headers: {}, text: '{}', json: { error: { message: 'Unknown voice "alloy".' } }, arrayBuffer: new ArrayBuffer(0) }));
    await expect(go('elevenlabs/eleven-v4', 'alloy')).rejects.toThrow(/Unknown voice "alloy"/);
    expect(bodies).toHaveLength(1);
  });

  it('sends no voice to a model that takes none', async () => {
    const bodies = capture(mp3);
    await go('fish-audio/s1', '');
    expect(bodies[0]).not.toHaveProperty('voice');
  });

  it('builds the live picker from each model’s own voices', async () => {
    const settings = JSON.parse(JSON.stringify(DEFAULT_LLM_PROVIDER_SETTINGS));
    settings.providers.openrouter = { ...settings.providers.openrouter, apiKey: 'k', enabled: true };
    __setRequestUrlMock(async () => ({ status: 200, headers: {}, text: '', arrayBuffer: new ArrayBuffer(0), json: { data: [
      { id: 'elevenlabs/eleven-v4', name: 'ElevenLabs: Eleven v4', supported_voices: ['george', 'sarah'] },
      { id: 'brandx/new-tts', name: 'Brand X', supported_voices: ['zed'] },
      { id: 'fish-audio/s1', name: 'Fish' },
    ] } }) as never);
    const models = await new SpeechModelCatalogService().getModels('openrouter', settings);
    expect(models.find(model => model.id === 'elevenlabs/eleven-v4')).toMatchObject({ defaultVoice: 'sarah', voices: [{ id: 'george', name: 'george' }, { id: 'sarah', name: 'sarah' }] });
    expect(models.find(model => model.id === 'brandx/new-tts')?.defaultVoice).toBe('zed');
    expect(models.find(model => model.id === 'fish-audio/s1')?.defaultVoice).toBeUndefined();
  });
});

/**
 * A bare requestUrl throws on non-2xx and discards the provider's explanation, and
 * Jest's mock returns the failure instead, so a regression passes every other test
 * and only shows up in the app. Paid provider calls go through ProviderHttpClient.
 */
describe('provider calls cannot lose the error body', () => {
  const GUARDED = [
    'src/services/readAloud/ElevenLabsSpeechAdapter.ts',
    'src/services/readAloud/GoogleSpeechAdapter.ts',
    'src/services/readAloud/MistralSpeechAdapter.ts',
    'src/services/readAloud/OpenAISpeechAdapter.ts',
    'src/services/readAloud/OpenRouterSpeechAdapter.ts',
    'src/services/video/adapters/OpenRouterVideoAdapter.ts',
    'src/services/llm/adapters/assemblyai/AssemblyAITranscriptionAdapter.ts',
    'src/services/llm/adapters/deepgram/DeepgramTranscriptionAdapter.ts',
    'src/services/llm/adapters/openai/OpenAITranscriptionAdapter.ts',
    'src/agents/apps/elevenlabs/tools/listVoices.ts',
    'src/agents/apps/elevenlabs/tools/musicGeneration.ts',
    'src/agents/apps/elevenlabs/tools/soundEffects.ts',
  ];

  it.each(GUARDED)('%s', file => {
    const source = jest.requireActual<typeof import('fs')>('fs').readFileSync(file, 'utf8');
    const bare = (source.match(/\brequestUrl\(\{[\s\S]*?\}\)/g) ?? []).filter(call => !/throw:\s*false/.test(call));
    // The OpenRouter video model listing tolerates failure and falls back to the catalog.
    const allowed = file.endsWith('OpenRouterVideoAdapter.ts') ? 1 : 0;
    expect(bare.length).toBeLessThanOrEqual(allowed);
  });
});
