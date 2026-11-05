/**
 * The generateAudio schema is written per setup, as the image and video ones are.
 * ElevenLabs is keyed through Apps, so its availability has a second path, and a
 * wrong output extension has to fail before synthesis is paid for.
 */
import { GenerateAudioTool, buildGenerateAudioDescription } from '../../src/agents/promptManager/tools/generateAudio';
import { PromptManagerAgent } from '../../src/agents/promptManager/promptManager';
import { ToolCliNormalizer } from '../../src/agents/toolManager/services/ToolCliNormalizer';
import { AudioGenerationService } from '../../src/services/audio/AudioGenerationService';
import { SpeechSynthesisService } from '../../src/services/readAloud/SpeechSynthesisService';
import { LLMSettingsNotifier } from '../../src/services/llm/LLMSettingsNotifier';
import { getSpeechModel, SPEECH_OUTPUT_EXTENSION } from '../../src/services/llm/types/SpeechTypes';
import { AppsTab } from '../../src/settings/tabs/AppsTab';
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

function elevenLabs(enabled = true, apiKey = 'eleven-key'): AppsSettings {
  return { apps: { elevenlabs: { enabled, credentials: { apiKey } } } } as unknown as AppsSettings;
}

const vault = { getName: () => 'test-vault', getAbstractFileByPath: () => null, createBinary: jest.fn(), adapter: {} };

function toolFor(settings: LLMProviderSettings, apps?: AppsSettings) {
  const tool = new GenerateAudioTool({ app: { vault } as never, vault: vault as never, llmSettings: settings, appsSettings: apps });
  const schema = tool.getParameterSchema() as unknown as {
    properties: Record<string, { description?: string; enum?: string[] }>;
  };
  return { tool, properties: schema.properties, text: `${tool.description} ${JSON.stringify(schema)}` };
}

describe('generateAudio schema follows the configured providers', () => {
  it('Google alone reads only Google rules, including its WAV output', () => {
    const { tool, properties, text } = toolFor(settingsWith(['google']));
    expect(tool.description).toContain('Google speech');
    expect(properties.provider.enum).toEqual(['google']);
    expect(properties.outputPath.description).toContain('ending in .wav');
    expect(properties.voice.description).toContain('Kore');
    expect(properties.prompt.description).toContain('8192 tokens on google');
    expect(text).not.toMatch(/openai|elevenlabs|mistral|openrouter|\.mp3|marin/i);
  });

  it('OpenAI alone gets a closed model list and each model\'s real voices', () => {
    const { properties, text } = toolFor(settingsWith(['openai']));
    expect(properties.model.enum).toEqual(['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']);
    expect(properties.outputPath.description).toContain('ending in .mp3');
    expect(properties.voice.description).toMatch(/marin[^;]*on openai: gpt-4o-mini-tts/);
    expect(properties.voice.description).toMatch(/shimmer on openai: tts-1, tts-1-hd/);
    expect(text).not.toMatch(/kore|\.wav|elevenlabs/i);
  });

  it('OpenRouter leaves the model open because its listing is live', () => {
    const { properties } = toolFor(settingsWith(['openrouter']));
    expect(properties.model).not.toHaveProperty('enum');
    expect(properties.model.description).toContain('also takes any other speech model');
  });

  it('spells out the extension per provider when they differ', () => {
    const { properties } = toolFor(settingsWith(['openai', 'google']));
    expect(properties.outputPath.description).toContain('.mp3 on openai');
    expect(properties.outputPath.description).toContain('.wav on google');
  });

  it('counts ElevenLabs only when the app is on and has a key', () => {
    expect(toolFor(settingsWith([]), elevenLabs()).properties.provider.enum).toEqual(['elevenlabs']);
    expect(toolFor(settingsWith([]), elevenLabs()).properties.voice.description).toContain('listVoices');
    expect(toolFor(settingsWith([]), elevenLabs(false)).properties.provider).not.toHaveProperty('enum');
    expect(toolFor(settingsWith([]), elevenLabs(true, ' ')).properties.provider).not.toHaveProperty('enum');
  });

  it('does not count a key on a disabled provider, or a disabled model', () => {
    const disabled = settingsWith(['openai', 'google']);
    disabled.providers.openai.enabled = false;
    expect(toolFor(disabled).properties.provider.enum).toEqual(['google']);

    const modelOff = settingsWith(['openai']);
    modelOff.providers.openai.models = { 'tts-1': { enabled: false } } as never;
    expect(toolFor(modelOff).properties.model.enum).toEqual(['gpt-4o-mini-tts', 'tts-1-hd']);
  });

  it('writes the description from what is configured', () => {
    expect(buildGenerateAudioDescription(settingsWith(['openai', 'google']), elevenLabs())).toBe(
      'Generate voice audio files in the vault from text, using configured Voice settings or ElevenLabs, OpenAI, or Google speech.'
    );
    expect(buildGenerateAudioDescription(settingsWith([]))).toBe('Generate voice audio files in the vault from text.');
  });
});

describe('speech catalog facts from the provider', () => {
  it.each(['tts-1', 'tts-1-hd'])('%s does not offer the voices its API rejects', model => {
    const voices = getSpeechModel('openai', model)?.voices?.map(voice => voice.id) ?? [];
    for (const voice of ['ballad', 'verse', 'marin', 'cedar']) expect(voices).not.toContain(voice);
    expect(voices).toContain(getSpeechModel('openai', model)?.defaultVoice);
  });

  it('gpt-4o-mini-tts keeps all of them', () => {
    const voices = getSpeechModel('openai', 'gpt-4o-mini-tts')?.voices?.map(voice => voice.id) ?? [];
    expect(voices).toEqual(expect.arrayContaining(['ballad', 'verse', 'marin', 'cedar']));
  });
});

describe('a wrong output extension', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['google', 'audio/a.mp3', '.wav'],
    ['openai', 'audio/a.wav', '.mp3']
  ] as const)('on %s fails at %s before synthesis is paid for', async (provider, outputPath, expected) => {
    const synthesize = jest.spyOn(SpeechSynthesisService.prototype, 'synthesize');
    const service = new AudioGenerationService({} as never, vault as never, { llmSettings: settingsWith([provider]) });
    await expect(service.generate({ prompt: 'Hello', provider, outputPath })).rejects.toThrow(`use "${expected}"`);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('checks the provider a default selection resolves to', async () => {
    const synthesize = jest.spyOn(SpeechSynthesisService.prototype, 'synthesize');
    const service = new AudioGenerationService({} as never, vault as never, { llmSettings: settingsWith(['google']) });
    await expect(service.generate({ prompt: 'Hello', outputPath: 'audio/a.mp3' })).rejects.toThrow('use ".wav"');
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('every speech provider declares its output type', () => {
    expect(Object.keys(SPEECH_OUTPUT_EXTENSION).sort()).toEqual(['elevenlabs', 'google', 'mistral', 'openai', 'openrouter']);
  });
});

describe('generateAudio through agent registration', () => {
  function agentWith(settings: LLMProviderSettings, apps?: AppsSettings) {
    const pluginSettings = { settings: { llmProviders: settings, customPrompts: { prompts: [] }, apps } };
    const agent = new PromptManagerAgent(
      pluginSettings as never,
      { getLLMService: () => ({}), getSettings: () => settings } as never,
      {} as never,
      {} as never,
      { vault } as never,
      vault as never,
      null
    );
    return { agent, pluginSettings };
  }

  function discovery(agent: PromptManagerAgent) {
    const tool = agent.getTool('generateAudio');
    return tool
      ? new ToolCliNormalizer(new Map([['promptManager', agent as never]])).buildCliSchema('promptManager', tool as never, { compact: true }).description
      : null;
  }

  it('describes the same setup when lazily registered', () => {
    expect(discovery(agentWith(settingsWith(['google'])).agent)).toContain('Google speech');
    expect(discovery(agentWith(settingsWith(['google'])).agent)).not.toContain('OpenAI');
  });

  it('appears and disappears when ElevenLabs changes in Apps, without a provider change', () => {
    const { agent, pluginSettings } = agentWith(settingsWith([]));
    expect(discovery(agent)).toBeNull();

    (pluginSettings.settings as { apps?: AppsSettings }).apps = elevenLabs();
    LLMSettingsNotifier.notifyAppsChanged();
    expect(discovery(agent)).toContain('ElevenLabs speech');

    (pluginSettings.settings as { apps?: AppsSettings }).apps = elevenLabs(false);
    LLMSettingsNotifier.notifyAppsChanged();
    expect(discovery(agent)).toBeNull();
  });

  it('stops following Apps changes after the agent is cleaned up', () => {
    const { agent, pluginSettings } = agentWith(settingsWith([]));
    agent.onunload();

    (pluginSettings.settings as { apps?: AppsSettings }).apps = elevenLabs();
    LLMSettingsNotifier.notifyAppsChanged();
    expect(discovery(agent)).toBeNull();
  });

  it('saving the Apps tab announces the change', async () => {
    const notify = jest.spyOn(LLMSettingsNotifier, 'notifyAppsChanged');
    const saveSettings = jest.fn(async () => undefined);
    const save = (AppsTab.prototype as unknown as { saveSettings: () => Promise<void> }).saveSettings;
    await save.call({ services: { settings: { settings: {}, saveSettings }, appManager: { getAppsSettings: () => elevenLabs() } } });
    expect(saveSettings).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    notify.mockRestore();
  });
});
