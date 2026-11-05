/**
 * generateAudio takes one `type` and adapts it per model. Providers differ: ElevenLabs
 * has parameters, Lyria reads requests from the prompt, Lyria Clip is always 30 seconds,
 * and OpenRouter only sends audio over a stream. The agent only sees what its keys can do.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';
import { GenerateAudioTool } from '../../src/agents/promptManager/tools/generateAudio';
import { AudioGenerationService } from '../../src/services/audio/AudioGenerationService';
import { buildGeneratedAudioPrompt, cleanLyrics } from '../../src/services/audio/GeneratedAudioAdapters';
import { getGeneratedAudioModel, listConfiguredGeneratedAudioModels } from '../../src/services/llm/types/GeneratedAudioTypes';
import { DEFAULT_LLM_PROVIDER_SETTINGS, LLMProviderSettings } from '../../src/types/llm/ProviderTypes';
import type { AppsSettings } from '../../src/types/apps/AppTypes';

type Provider = 'google' | 'openai' | 'openrouter' | 'mistral';

function settingsWith(providers: Provider[]): LLMProviderSettings {
  const settings = JSON.parse(JSON.stringify(DEFAULT_LLM_PROVIDER_SETTINGS)) as LLMProviderSettings;
  for (const provider of providers) {
    settings.providers[provider] = { ...settings.providers[provider], apiKey: `${provider}-key`, enabled: true };
  }
  return settings;
}
const elevenLabs = { apps: { elevenlabs: { enabled: true, credentials: { apiKey: 'el-key' } } } } as unknown as AppsSettings;
const saved: Array<{ path: string; size: number }> = [];
const vault = {
  getAbstractFileByPath: () => null,
  createFolder: async () => undefined,
  createBinary: async (path: string, data: ArrayBuffer) => { saved.push({ path, size: data.byteLength }); },
};
const service = (providers: Provider[], apps?: AppsSettings) => new AudioGenerationService({} as never, vault as never, { llmSettings: settingsWith(providers), appsSettings: apps });
const schemaOf = (providers: Provider[], apps?: AppsSettings) => {
  const tool = new GenerateAudioTool({ app: { vault } as never, vault: vault as never, llmSettings: settingsWith(providers), appsSettings: apps });
  const schema = tool.getParameterSchema() as unknown as { properties: Record<string, { description?: string; enum?: string[] }> };
  return { tool, properties: schema.properties, text: `${tool.description} ${JSON.stringify(schema)}` };
};

const b64 = Buffer.from('ID3 audio').toString('base64');
function capture(respond: (request: { url: string; body?: string }) => unknown) {
  const requests: Array<{ url: string; body: Record<string, unknown>; headers?: Record<string, string> }> = [];
  __setRequestUrlMock(async (request: { url: string; body?: string; headers?: Record<string, string> }) => {
    requests.push({ url: request.url, headers: request.headers, body: JSON.parse(String(request.body)) });
    return respond(request) as never;
  });
  return requests;
}
const audioBytes = () => ({ status: 200, headers: {}, text: '', json: null, arrayBuffer: new Uint8Array([1, 2, 3]).buffer });
const interaction = (text = '[Verse]\nLa la') => ({ status: 200, headers: {}, text: '', arrayBuffer: new ArrayBuffer(0), json: { status: 'completed', steps: [{ content: [{ type: 'text', text }] }, { content: [{ type: 'audio', mime_type: 'audio/mpeg', data: b64 }] }] } });
const sse = (lines: string[]) => ({ status: 200, headers: {}, text: lines.join('\n'), arrayBuffer: new ArrayBuffer(0), get json(): unknown { throw new SyntaxError('not json'); } });
const delta = (value: unknown) => `data: ${JSON.stringify({ choices: [{ delta: value }] })}`;

beforeEach(() => { saved.length = 0; });

describe('the schema follows the configured keys', () => {
  it('no music provider means no type parameter and no music wording', () => {
    const { properties, text } = schemaOf(['openai']);
    for (const param of ['type', 'mode', 'durationSeconds', 'instrumental', 'loop']) expect(properties).not.toHaveProperty(param);
    expect(text).not.toMatch(/music|sfx|lyria/i);
  });

  it('Google offers speech and music, with no sound effects or loop', () => {
    const { tool, properties, text } = schemaOf(['google']);
    expect(properties.type.enum).toEqual(['speech', 'music']);
    expect(properties).not.toHaveProperty('loop');
    expect(tool.description).toContain('Also makes music (Google)');
    expect(tool.description).not.toContain('sound effects');
    expect(properties.durationSeconds.description).toMatch(/always 30s on google: lyria-3-clip-preview/);
    expect(properties.durationSeconds.description).toMatch(/can be far off on google: lyria-3\.5/);
    expect(text).not.toMatch(/eleven/i);
  });

  it('OpenRouter offers its Lyria routes', () => {
    const { properties } = schemaOf(['openrouter']);
    expect(properties.type.enum).toEqual(['speech', 'music']);
    expect(properties.model.description).toContain('google/lyria-3-pro-preview');
    expect(properties.model.description).not.toContain('lyria-3.5');
  });

  it('ElevenLabs offers all three, with a length range and looping', () => {
    const { tool, properties } = schemaOf([], elevenLabs);
    expect(properties.type.enum).toEqual(['speech', 'music', 'sfx']);
    expect(properties.durationSeconds.description).toMatch(/3-600s, usually close on elevenlabs: music_v2_5/);
    expect(properties.durationSeconds.description).toMatch(/0\.5-30s, usually close on elevenlabs: eleven_text_to_sound_v3/);
    expect(properties.loop.description).toContain('eleven_text_to_sound_v3');
    expect(properties.instrumental.description).toMatch(/guaranteed on elevenlabs: music_v2_5/);
    expect(tool.description).toContain('Also makes sound effects (ElevenLabs)');
  });

  it('a key on a disabled provider does not count', () => {
    const settings = settingsWith(['google']);
    settings.providers.google.enabled = false;
    expect(listConfiguredGeneratedAudioModels(settings)).toEqual([]);
  });
});

describe('each provider gets its own request from one generic call', () => {
  it('ElevenLabs music takes real parameters', async () => {
    const requests = capture(audioBytes);
    const result = await service([], elevenLabs).generate({ type: 'music', prompt: 'jazz', durationSeconds: 45, instrumental: true, outputPath: 'a.mp3' });
    expect(requests[0].url).toContain('/v1/music');
    expect(requests[0].headers?.['xi-api-key']).toBe('el-key');
    expect(requests[0].body).toEqual({ prompt: 'jazz', model_id: 'music_v2_5', music_length_ms: 45000, force_instrumental: true });
    expect(result).toMatchObject({ type: 'music', provider: 'elevenlabs', model: 'music_v2_5', path: 'a.mp3' });
    expect(result).not.toHaveProperty('note');
  });

  it('ElevenLabs sound effects take real parameters', async () => {
    const requests = capture(audioBytes);
    const result = await service([], elevenLabs).generate({ type: 'sfx', prompt: 'rain', durationSeconds: 2.5, loop: true, outputPath: 'a.mp3' });
    expect(requests[0].url).toContain('/v1/sound-generation');
    expect(requests[0].body).toEqual({ text: 'rain', model_id: 'eleven_text_to_sound_v3', duration_seconds: 2.5, loop: true });
    expect(result.type).toBe('sfx');
  });

  it('Google writes requests into the prompt, and returns lyrics', async () => {
    const requests = capture(() => interaction());
    const result = await service(['google']).generate({ type: 'music', prompt: 'a piano piece', durationSeconds: 120, instrumental: true, outputPath: 'a.mp3' });
    expect(requests[0].url).toContain('/v1beta/interactions');
    expect(requests[0].body).toEqual({ model: 'lyria-3.5', input: 'a piano piece Make it about 120 seconds long. Instrumental only, no vocals.' });
    expect(result).toMatchObject({ provider: 'google', model: 'lyria-3.5', lyrics: '[Verse]\nLa la' });
    expect(result.note).toContain('can be far off');
    expect(saved[0].path).toBe('a.mp3');
  });

  it('does not report Lyria’s <instrumental> placeholder as lyrics', async () => {
    capture(() => interaction('<instrumental>'));
    const result = await service(['google']).generate({ type: 'music', prompt: 'x', outputPath: 'a.mp3' });
    expect(result).not.toHaveProperty('lyrics');
  });

  it('Lyria Clip says it ignored the length rather than pretending', async () => {
    const requests = capture(() => interaction());
    const result = await service(['google']).generate({ type: 'music', model: 'lyria-3-clip-preview', prompt: 'x', durationSeconds: 90, outputPath: 'a.mp3' });
    expect(requests[0].body.input).toBe('x');
    expect(result.note).toContain('always makes 30 seconds');
  });

  it('OpenRouter assembles audio from the stream', async () => {
    const requests = capture(() => sse([': OPENROUTER PROCESSING', delta({ content: '<instrumental>' }), delta({ audio: { data: b64 } }), 'data: [DONE]']));
    const result = await service(['openrouter']).generate({ type: 'music', prompt: 'x', outputPath: 'a.mp3' });
    expect(requests[0].body).toMatchObject({ model: 'google/lyria-3-pro-preview', stream: true, modalities: ['text', 'audio'] });
    expect(result).toMatchObject({ provider: 'openrouter', mimeType: 'audio/mpeg' });
    expect(saved[0].size).toBe(Buffer.from('ID3 audio').length);
  });

  it('reports an error that arrives after the stream opened', async () => {
    capture(() => sse([`data: ${JSON.stringify({ error: { message: 'Prompt blocked' } })}`]));
    await expect(service(['openrouter']).generate({ type: 'music', prompt: 'x', outputPath: 'a.mp3' })).rejects.toThrow(/Prompt blocked/);
    expect(saved).toHaveLength(0);
  });

  it('explains a Google response with no audio', async () => {
    capture(() => ({ status: 200, headers: {}, text: '', arrayBuffer: new ArrayBuffer(0), json: { status: 'failed', steps: [] } }));
    await expect(service(['google']).generate({ type: 'music', prompt: 'x', outputPath: 'a.mp3' })).rejects.toThrow(/returned no audio \(status failed\)/);
  });
});

describe('output paths stay in the vault', () => {
  it.each(['../../../../tmp/ESCAPE.mp3', '~/ESCAPE.mp3'])('rejects %s for music with no request and no write', async outputPath => {
    const request = jest.fn();
    __setRequestUrlMock(request as never);
    await expect(service([], elevenLabs).generate({ type: 'music', prompt: 'x', outputPath })).rejects.toThrow(/Invalid outputPath/);
    expect(request).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });
});

describe('choosing a model', () => {
  it('honours an explicit model and an explicit provider', async () => {
    const requests = capture(audioBytes);
    await service(['google'], elevenLabs).generate({ type: 'music', provider: 'elevenlabs', prompt: 'x', outputPath: 'a.mp3' });
    expect(requests[0].url).toContain('elevenlabs');
    const google = capture(() => interaction());
    await service(['google'], elevenLabs).generate({ type: 'music', model: 'lyria-3-clip-preview', prompt: 'x', outputPath: 'a.mp3' });
    expect(google[0].body.model).toBe('lyria-3-clip-preview');
  });

  it.each([
    ['sound effects with no ElevenLabs', () => service(['google']).generate({ type: 'sfx', prompt: 'x', outputPath: 'a.mp3' }), /Sound effects need an ElevenLabs key/],
    ['music with no provider', () => service(['openai']).generate({ type: 'music', prompt: 'x', outputPath: 'a.mp3' }), /Music needs an ElevenLabs, Google or OpenRouter key/],
    ['a speech model used for music', () => service(['google']).generate({ type: 'music', model: 'gemini-3.8-flash-tts', prompt: 'x', outputPath: 'a.mp3' }), /Music is not available with gemini-3\.8-flash-tts.*lyria-3\.5/],
    ['sound effects from a provider without them', () => service(['google'], elevenLabs).generate({ type: 'sfx', provider: 'google', prompt: 'x', outputPath: 'a.mp3' }), /^Sound effects are not available on google\. Available: eleven_text_to_sound_v3 on elevenlabs/],
    ['a length past the limit', () => service([], elevenLabs).generate({ type: 'sfx', prompt: 'x', durationSeconds: 45, outputPath: 'a.mp3' }), /takes durationSeconds from 0\.5 to 30/],
    ['a WAV path for music', () => service(['google']).generate({ type: 'music', prompt: 'x', outputPath: 'a.wav' }), /use "\.mp3"/],
    ['an unknown type', () => service(['google']).generate({ type: 'podcast' as never, prompt: 'x', outputPath: 'a.mp3' }), /Unsupported audio type "podcast"/],
  ])('rejects %s before any request', async (_label, run, message) => {
    const request = jest.fn();
    __setRequestUrlMock(request as never);
    await expect(run()).rejects.toThrow(message);
    expect(request).not.toHaveBeenCalled();
  });

  it('notes options a model cannot use', async () => {
    capture(audioBytes);
    const sfx = await service([], elevenLabs).generate({ type: 'sfx', prompt: 'x', voice: 'Kore', instrumental: true, outputPath: 'a.mp3' });
    expect(sfx.note).toContain('voice ignored for sfx');
    expect(sfx.note).toContain('instrumental ignored');
    const music = await service([], elevenLabs).generate({ type: 'music', prompt: 'x', loop: true, outputPath: 'b.mp3' });
    expect(music.note).toContain('music_v2_5 cannot loop');
  });
});

describe('speech keeps working', () => {
  const tts = () => ({ status: 200, headers: {}, text: '', json: null, arrayBuffer: new ArrayBuffer(4) });

  it.each([[undefined], ['speech'], ['voice']])('type or old mode %s means speech', async which => {
    const requests = capture(tts);
    const result = await service(['openai']).generate({
      ...(which === 'voice' ? { mode: 'voice' as const } : which === 'speech' ? { type: 'speech' as const } : {}),
      prompt: 'hello', provider: 'openai', model: 'tts-1', outputPath: 'a.mp3'
    });
    expect(requests[0].url).toContain('/audio/speech');
    expect(result).toMatchObject({ type: 'speech', voice: 'alloy' });
  });

  it('says when a music option had no effect', async () => {
    capture(tts);
    const result = await service(['openai']).generate({ prompt: 'x', provider: 'openai', model: 'tts-1', durationSeconds: 5, outputPath: 'a.mp3' });
    expect(result.note).toContain('durationSeconds ignored for speech');
  });
});

describe('lyrics are only words', () => {
  it.each([
    ['<instrumental>', undefined],
    ['[[A0]]\n[[B1]]\n[[C2]]', undefined],
    ['', undefined],
    ['[[A0]]\n[[B1]]\n[:] I\'m a little teacup\n[:] Short and stout', "I'm a little teacup\nShort and stout"],
    ['[0.0:] I\'m a happy little teacup,\n[3.7:] Ready for my morning', "[0.0:] I'm a happy little teacup,\n[3.7:] Ready for my morning"],
  ])('%s', (input, expected) => {
    expect(cleanLyrics(input)).toBe(expected);
  });
});

describe('a stream with no audio', () => {
  it('says it may be temporary, gives the reason, and does not bill twice', async () => {
    const requests = capture(() => sse([`data: ${JSON.stringify({ choices: [{ finish_reason: 'stop', delta: { content: '[[A0]]' } }] })}`, 'data: [DONE]']));
    await expect(service(['openrouter']).generate({ type: 'music', prompt: 'x', outputPath: 'a.mp3' })).rejects.toThrow(/no audio \(finish reason stop\).*try again/);
    expect(requests).toHaveLength(1);
    expect(saved).toHaveLength(0);
  });
});

describe('prompt additions', () => {
  it('leaves a model with real parameters alone', () => {
    const model = getGeneratedAudioModel('elevenlabs', 'music_v2_5')!;
    expect(buildGeneratedAudioPrompt({ model, prompt: 'jazz', durationSeconds: 10, instrumental: true })).toBe('jazz');
  });

  it('does not ask for instrumental unless told to', () => {
    const model = getGeneratedAudioModel('google', 'lyria-3.5')!;
    expect(buildGeneratedAudioPrompt({ model, prompt: 'a song', instrumental: false })).toBe('a song');
  });
});
