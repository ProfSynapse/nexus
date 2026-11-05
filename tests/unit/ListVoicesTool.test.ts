/**
 * One voice list for every provider. It reads the catalog that fills the Voice
 * settings picker and reports the default generateAudio will really use, so the
 * picker, this tool and generation cannot disagree.
 */
import { __setRequestUrlMock } from '../mocks/obsidian';
import { ListVoicesTool } from '../../src/agents/promptManager/tools/listVoices';
import { GenerateAudioTool } from '../../src/agents/promptManager/tools/generateAudio';
import { PromptManagerAgent } from '../../src/agents/promptManager/promptManager';
import { LLMSettingsNotifier } from '../../src/services/llm/LLMSettingsNotifier';
import { getRegisteredToolExecutionPolicy } from '../../src/agents/policy/ToolExecutionPolicyCatalog';
import { ElevenLabsAgent } from '../../src/agents/apps/elevenlabs/ElevenLabsAgent';
import { DEFAULT_LLM_PROVIDER_SETTINGS, LLMProviderSettings } from '../../src/types/llm/ProviderTypes';
import type { AppsSettings } from '../../src/types/apps/AppTypes';

type Provider = 'google' | 'openai' | 'openrouter' | 'mistral';
function settingsWith(providers: Provider[], extra: Partial<LLMProviderSettings> = {}): LLMProviderSettings {
  const settings = JSON.parse(JSON.stringify(DEFAULT_LLM_PROVIDER_SETTINGS)) as LLMProviderSettings;
  for (const provider of providers) {
    settings.providers[provider] = { ...settings.providers[provider], apiKey: `${provider}-key`, enabled: true };
  }
  delete settings.defaultSpeechModel;
  return { ...settings, ...extra };
}
const elevenLabs = { apps: { elevenlabs: { enabled: true, credentials: { apiKey: 'el-key' } } } } as unknown as AppsSettings;
const noRequests = () => __setRequestUrlMock((async () => { throw new Error('unexpected request'); }) as never);

type Listed = { success: boolean; error?: string; data?: { provider: string; model: string; defaultVoice?: string; count: number; note?: string; voices: Array<{ id: string; isDefault?: boolean; description?: string }> } };
const list = (tool: ListVoicesTool, params: Record<string, unknown> = {}) => tool.execute(params as never) as unknown as Promise<Listed>;

describe('listVoices', () => {
  it('with nothing named, lists the Voice settings model and marks the saved voice', async () => {
    noRequests();
    const tool = new ListVoicesTool({ llmSettings: settingsWith(['google'], { defaultSpeechModel: { provider: 'google', model: 'gemini-3.8-flash-lite-tts', voice: 'Puck', source: 'user' } }) });
    const result = await list(tool);
    expect(result.data).toMatchObject({ provider: 'google', model: 'gemini-3.8-flash-lite-tts', defaultVoice: 'Puck' });
    expect(result.data?.voices.filter(voice => voice.isDefault).map(voice => voice.id)).toEqual(['Puck']);
  });

  it('uses the model’s own default when settings chose a different model', async () => {
    noRequests();
    const tool = new ListVoicesTool({ llmSettings: settingsWith(['openai'], { defaultSpeechModel: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'marin', source: 'user' } }) });
    const result = await list(tool, { provider: 'openai', model: 'tts-1' });
    expect(result.data?.defaultVoice).toBe('alloy');
    expect(result.data?.voices.map(voice => voice.id)).not.toContain('marin');
  });

  it('reports the same default generateAudio then uses', async () => {
    const settings = settingsWith(['google'], { defaultSpeechModel: { provider: 'google', model: 'gemini-3.8-flash-tts', voice: 'Puck', source: 'user' } });
    noRequests();
    const listed = await list(new ListVoicesTool({ llmSettings: settings }));
    const pcm = Buffer.alloc(8).toString('base64');
    __setRequestUrlMock((async () => ({ status: 200, headers: {}, text: '', arrayBuffer: new ArrayBuffer(0), json: { candidates: [{ content: { parts: [{ inlineData: { data: pcm } }] } }] } })) as never);
    const vault = { getAbstractFileByPath: () => null, createFolder: async () => undefined, createBinary: async () => undefined };
    const generated = await new GenerateAudioTool({ app: { vault } as never, vault: vault as never, llmSettings: settings }).execute({ prompt: 'hi', outputPath: 'a.wav' } as never) as unknown as { data?: { voice: string; model: string } };
    expect(generated.data).toMatchObject({ voice: listed.data?.defaultVoice, model: listed.data?.model });
  });

  it('reads an ElevenLabs account’s own library, through the provider’s API', async () => {
    __setRequestUrlMock((async () => ({ status: 200, headers: {}, text: '', arrayBuffer: new ArrayBuffer(0), json: { voices: [
      { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', category: 'premade' },
      { voice_id: 'clone1', name: 'My Clone', category: 'cloned' },
    ] } })) as never);
    const result = await list(new ListVoicesTool({ llmSettings: settingsWith([]), appsSettings: elevenLabs }), { provider: 'elevenlabs', model: 'eleven_v4' });
    expect(result.data?.defaultVoice).toBe('EXAVITQu4vr4xnSDxMaL');
    expect(result.data?.voices).toEqual([
      { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah', description: 'premade', isDefault: true },
      { id: 'clone1', name: 'My Clone', description: 'cloned' },
    ]);
  });

  it('reads OpenRouter voices for the model named', async () => {
    __setRequestUrlMock((async () => ({ status: 200, headers: {}, text: '', arrayBuffer: new ArrayBuffer(0), json: { data: [
      { id: 'x-ai/grok-voice-tts-1.0', name: 'Grok', supported_voices: ['eve', 'ara'] },
    ] } })) as never);
    const result = await list(new ListVoicesTool({ llmSettings: settingsWith(['openrouter']) }), { provider: 'openrouter', model: 'x-ai/grok-voice-tts-1.0' });
    expect(result.data?.voices.map(voice => voice.id)).toEqual(['eve', 'ara']);
    expect(result.data?.defaultVoice).toBe('eve');
  });

  it('filters by search across name, ID and description', async () => {
    noRequests();
    const tool = new ListVoicesTool({ llmSettings: settingsWith(['google']) });
    const result = await list(tool, { provider: 'google', model: 'gemini-3.8-flash-tts', search: 'warm' });
    expect(result.data?.voices.map(voice => voice.id)).toEqual(['Sulafat']);
    expect(result.data?.count).toBe(1);
  });

  it('caps a huge library and says how to narrow it', async () => {
    __setRequestUrlMock((async () => ({ status: 200, headers: {}, text: '', arrayBuffer: new ArrayBuffer(0), json: { voices: Array.from({ length: 250 }, (_, i) => ({ voice_id: `v${i}`, name: `Voice ${i}`, category: 'cloned' })) } })) as never);
    const result = await list(new ListVoicesTool({ llmSettings: settingsWith([]), appsSettings: elevenLabs }), { provider: 'elevenlabs', model: 'eleven_v4' });
    expect(result.data?.voices).toHaveLength(200);
    expect(result.data?.count).toBe(250);
    expect(result.data?.note).toContain('Use search');
  });

  it('says so when a model has no voices to choose', async () => {
    __setRequestUrlMock((async () => ({ status: 200, headers: {}, text: '', arrayBuffer: new ArrayBuffer(0), json: { data: [{ id: 'fish-audio/s1', name: 'Fish' }] } })) as never);
    const result = await list(new ListVoicesTool({ llmSettings: settingsWith(['openrouter']) }), { provider: 'openrouter', model: 'fish-audio/s1' });
    expect(result.data?.voices).toEqual([]);
    expect(result.data?.note).toContain('leave voice out');
  });

  it('reports a provider’s refusal instead of an empty list', async () => {
    const body = { detail: { message: 'The API key you used is missing the permission voices_read to execute this operation.' } };
    __setRequestUrlMock((async () => ({ status: 401, headers: {}, text: JSON.stringify(body), json: body, arrayBuffer: new ArrayBuffer(0) })) as never);
    const result = await list(new ListVoicesTool({ llmSettings: settingsWith([]), appsSettings: elevenLabs }), { provider: 'elevenlabs', model: 'eleven_v4' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('missing the voices_read permission');
  });

  it('refuses a provider with no key rather than listing what cannot be used', async () => {
    noRequests();
    const result = await list(new ListVoicesTool({ llmSettings: settingsWith(['google']) }), { provider: 'openai', model: 'tts-1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not enabled and configured');
  });

  it('offers only providers with a key', () => {
    const schema = new ListVoicesTool({ llmSettings: settingsWith(['google']), appsSettings: elevenLabs }).getParameterSchema() as unknown as { properties: { provider: { enum: string[] } } };
    expect(schema.properties.provider.enum.sort()).toEqual(['elevenlabs', 'google']);
  });

  it('runs in parallel as a read', () => {
    expect(getRegisteredToolExecutionPolicy('promptManager', 'listVoices')).toMatchObject({ effect: 'read', parallelSafe: true });
  });
});

describe('registration', () => {
  function agentWith(settings: LLMProviderSettings) {
    const vault = { getName: () => 'test-vault', getAbstractFileByPath: () => null, adapter: {} };
    const plugin = { settings: { llmProviders: settings, customPrompts: { prompts: [] }, apps: { apps: {} } } };
    return new PromptManagerAgent(plugin as never, { getLLMService: () => ({}), getSettings: () => settings } as never, {} as never, {} as never, { vault } as never, vault as never, null);
  }

  it('follows the same keys as generateAudio, without a reload', () => {
    const agent = agentWith(settingsWith([]));
    expect(agent.hasTool('listVoices')).toBe(false);
    LLMSettingsNotifier.notify(settingsWith(['google']));
    expect(agent.hasTool('listVoices')).toBe(true);
    LLMSettingsNotifier.notify(settingsWith([]));
    expect(agent.hasTool('listVoices')).toBe(false);
    agent.onunload();
  });

  it('ElevenLabs has no tools of its own left', () => {
    expect(new ElevenLabsAgent().getTools()).toEqual([]);
  });
});
