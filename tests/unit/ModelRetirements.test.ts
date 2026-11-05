/**
 * Models removed because their provider shuts them down. A saved selection or an
 * old request naming one must land on the documented successor, not fail on the
 * shutdown date. ElevenLabs must never fall back to a deprecated API default.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';
import { normalizeRetiredMediaDefaults, getRetiredRealtimeModel, getRetiredSpeechModel } from '../../src/services/llm/types/RetiredMediaModels';
import { getSpeechModel, getSpeechModelsForProvider, resolveDefaultSpeechSelection } from '../../src/services/llm/types/SpeechTypes';
import { getRealtimeVoiceModel, resolveDefaultRealtimeVoiceSelection } from '../../src/services/llm/types/RealtimeVoiceTypes';
import { SpeechSynthesisService } from '../../src/services/readAloud/SpeechSynthesisService';
import { ModelRegistry } from '../../src/services/llm/adapters/ModelRegistry';
import { getVideoModel } from '../../src/services/llm/types/VideoTypes';
import { OpenRouterVideoAdapter } from '../../src/services/video/adapters/OpenRouterVideoAdapter';
import { DEFAULT_LLM_PROVIDER_SETTINGS, LLMProviderSettings } from '../../src/types/llm/ProviderTypes';

function settingsWith(providers: Array<'google' | 'openai'>, extra: Partial<LLMProviderSettings> = {}): LLMProviderSettings {
  const settings = JSON.parse(JSON.stringify(DEFAULT_LLM_PROVIDER_SETTINGS)) as LLMProviderSettings;
  for (const provider of providers) {
    settings.providers[provider] = { ...settings.providers[provider], apiKey: `${provider}-key`, enabled: true };
  }
  return { ...settings, ...extra };
}

describe('retired speech models', () => {
  it.each(['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'])('%s is gone and maps to a shipped successor', id => {
    expect(getSpeechModel('google', id)).toBeUndefined();
    const replacement = getRetiredSpeechModel('google', id)?.replacement;
    expect(getSpeechModel('google', replacement)).toBeDefined();
  });

  it('a saved default keeps working and keeps its voice', () => {
    const settings = settingsWith(['google'], {
      defaultSpeechModel: { provider: 'google', model: 'gemini-3.1-flash-tts-preview', voice: 'Puck', source: 'user' }
    });
    expect(resolveDefaultSpeechSelection(settings)).toMatchObject({ model: 'gemini-3.8-flash-tts', voice: 'Puck', status: 'resolved' });
    expect(normalizeRetiredMediaDefaults(settings)).toBe(true);
    expect(settings.defaultSpeechModel).toMatchObject({ model: 'gemini-3.8-flash-tts', voice: 'Puck' });
  });

  it('an explicit request naming one resolves to the successor', () => {
    const service = new SpeechSynthesisService(settingsWith(['google']));
    expect(service.resolveRequest({ text: 'hi', provider: 'google', model: 'gemini-2.5-pro-preview-tts' }).model).toBe('gemini-3.8-flash-tts');
  });

  it('does not map a current id, or the same id on another provider', () => {
    expect(getRetiredSpeechModel('google', 'gemini-3.8-flash-tts')).toBeUndefined();
    expect(getRetiredSpeechModel('openai', 'gemini-3.1-flash-tts-preview')).toBeUndefined();
    expect(getRetiredSpeechModel('google', 'constructor')).toBeUndefined();
  });
});

describe('retired realtime models', () => {
  it.each([
    ['google', 'gemini-3.1-flash-live-preview', 'gemini-3.8-live'],
    ['openai', 'gpt-realtime-mini', 'gpt-realtime-2.1-mini']
  ] as const)('%s %s is gone and a saved default moves to %s', (provider, id, successor) => {
    expect(getRealtimeVoiceModel(provider, id)).toBeUndefined();
    expect(getRealtimeVoiceModel(provider, successor)).toBeDefined();
    const settings = settingsWith([provider], { defaultRealtimeVoiceModel: { provider, model: id, source: 'user' } });
    expect(resolveDefaultRealtimeVoiceSelection(settings)).toMatchObject({ model: successor, status: 'resolved' });
    expect(getRetiredRealtimeModel(provider, id)?.replacement).toBe(successor);
    expect(normalizeRetiredMediaDefaults(settings)).toBe(true);
    expect(settings.defaultRealtimeVoiceModel?.model).toBe(successor);
  });
});

describe('chat models past or at shutdown are gone', () => {
  it.each([
    ['openrouter', 'minimax/minimax-m2.7'],
    ['openrouter', 'xiaomi/mimo-v2-omni'],
    ['openrouter', 'xiaomi/mimo-v2-pro'],
    ['openrouter', 'anthropic/claude-haiku-4-5'],
    ['groq', 'qwen/qwen3.6-27b'],
    ['mistral', 'mistral-saba-latest'],
    ['openai-codex', 'gpt-5.2-codex'],
    ['openai-codex', 'gpt-5.1-codex'],
    ['openai-codex', 'gpt-5.1-codex-max'],
    ['openai-codex', 'gpt-5.1-codex-mini']
  ])('%s %s', (provider, id) => {
    expect(ModelRegistry.findModel(provider, id)).toBeUndefined();
  });

  it.each([
    ['openai', 'gpt-6.1-terra'],
    ['openai-codex', 'gpt-6.1-terra'],
    ['openrouter', 'openai/gpt-6.1-terra'],
    ['openrouter', 'google/gemini-4-argon'],
    ['openrouter', 'anthropic/claude-haiku-4.5']
  ])('%s %s is offered', (provider, id) => {
    expect(ModelRegistry.findModel(provider, id)).toBeDefined();
  });
});

describe('ElevenLabs speech catalog', () => {
  it('keeps Multilingual v2 first and a saved Turbo default working', () => {
    const models = getSpeechModelsForProvider('elevenlabs');
    expect(models[0].id).toBe('eleven_multilingual_v2');
    expect(getSpeechModel('elevenlabs', 'eleven_turbo_v2_5')?.deprecated).toBe(true);
    expect(getSpeechModel('elevenlabs', 'eleven_v4')?.maxInputChars).toBe(10000);
  });
});

describe('OpenRouter video resolutions', () => {
  it.each([
    ['minimax/hailuo-3', '2k', '2K'],
    ['black-forest-labs/flux-3-video', '4k', '4K'],
    ['alibaba/wan-3.0', '720p', '720p']
  ])('%s sends %s as %s, the case OpenRouter requires', async (model, resolution, wire) => {
    const bodies: Array<Record<string, unknown>> = [];
    __setRequestUrlMock(async (request: { method?: string; body?: string }) => {
      if (request.method === 'POST') bodies.push(JSON.parse(String(request.body)));
      return { status: 500, headers: {}, text: 'stop here', json: {}, arrayBuffer: new ArrayBuffer(0) } as never;
    });
    const adapter = new OpenRouterVideoAdapter({ apiKey: 'or-key', vault: {} as never } as never);
    await (adapter as unknown as { submitJob: (r: unknown) => Promise<unknown> })
      .submitJob({ prompt: 'a beach', provider: 'openrouter', model, aspectRatio: '16:9', resolution })
      .catch(() => undefined);
    expect(bodies[0].resolution).toBe(wire);
  });

  it('declares Hailuo as 2K only, so its default is one it accepts', () => {
    expect(getVideoModel('openrouter', 'minimax/hailuo-3')).toMatchObject({ resolutions: ['2k'], defaultResolution: '2k' });
  });
});

describe('OpenRouter video negative prompts', () => {
  async function bodyFor(model: string) {
    const bodies: Array<Record<string, unknown>> = [];
    __setRequestUrlMock(async (request: { url: string; method?: string; body?: string }) => {
      if (request.method === 'POST') bodies.push(JSON.parse(String(request.body)));
      return { status: 500, headers: {}, text: 'stop here', json: {}, arrayBuffer: new ArrayBuffer(0) } as never;
    });
    const adapter = new OpenRouterVideoAdapter({ apiKey: 'or-key', vault: {} as never } as never);
    await (adapter as unknown as { submitJob: (r: unknown) => Promise<unknown> })
      .submitJob({ prompt: 'a beach', provider: 'openrouter', model, aspectRatio: '16:9', resolution: '720p', negativePrompt: 'people' })
      .catch(() => undefined);
    return bodies[0];
  }

  it('sends Veo the documented passthrough, not an undocumented top-level field', async () => {
    const body = await bodyFor('google/veo-3.1-lite');
    expect(body).not.toHaveProperty('negative_prompt');
    expect(body.prompt).toBe('a beach');
    expect(body.provider).toEqual({ options: { 'google-vertex': { parameters: { negativePrompt: 'people' } } } });
  });

  it('adds it to the prompt for Kling, whose passthrough slug is not published', async () => {
    const body = await bodyFor('kwaivgi/kling-v3.0-pro');
    expect(body).not.toHaveProperty('negative_prompt');
    expect(body).not.toHaveProperty('provider');
    expect(body.prompt).toBe('a beach\n\nDo not include: people');
  });
});
