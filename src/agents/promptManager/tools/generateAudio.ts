import { App, Vault } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { CommonParameters, CommonResult } from '../../../types';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import { labelNamed, verbs } from '../../utils/toolStatusLabels';
import type { ToolStatusTense } from '../../interfaces/ITool';
import type { AppsSettings } from '../../../types/apps/AppTypes';
import type { LLMProviderSettings } from '../../../types/llm/ProviderTypes';
import {
  AudioGenerationService,
  type AudioGenerationMode
} from '../../../services/audio/AudioGenerationService';
import {
  buildSpeechProviderAvailability,
  getSpeechAppCapabilityStates,
  getSpeechOutputExtension,
  listConfiguredSpeechProviders,
  resolveDefaultSpeechSelection,
  SPEECH_OUTPUT_EXTENSION,
  type SpeechModelDeclaration,
  type SpeechProvider
} from '../../../services/llm/types/SpeechTypes';
import { describeModelsByProvider, groupModels, joinWithOr } from '../../../services/llm/mediaModelText';
import {
  listConfiguredGeneratedAudioModels,
  type AudioType,
  type GeneratedAudioModelDeclaration,
  type GeneratedAudioType,
} from '../../../services/llm/types/GeneratedAudioTypes';

const PROVIDER_NAMES: Record<SpeechProvider, string> = {
  elevenlabs: 'ElevenLabs',
  openai: 'OpenAI',
  google: 'Google',
  mistral: 'Mistral',
  openrouter: 'OpenRouter'
};

function providerNamesOf(models: GeneratedAudioModelDeclaration[], type: GeneratedAudioType): string[] {
  return Array.from(new Set(models.filter(model => model.type === type).map(model => PROVIDER_NAMES[model.provider])));
}

/**
 * The one-line description an agent sees before it asks for the full schema.
 * Written only from the providers that have a key.
 */
export function buildGenerateAudioDescription(
  llmSettings: LLMProviderSettings | null | undefined,
  appsSettings?: AppsSettings | null
): string {
  const names = listConfiguredSpeechProviders(llmSettings, appsSettings).map(item => PROVIDER_NAMES[item.provider]);
  const generated = listConfiguredGeneratedAudioModels(llmSettings, appsSettings);
  const sentences = [names.length > 0
    ? `Generate voice audio files in the vault from text, using configured Voice settings or ${joinWithOr(names)} speech.`
    : 'Generate voice audio files in the vault from text.'];
  const music = providerNamesOf(generated, 'music');
  if (music.length > 0) sentences.push(`Also makes music (${joinWithOr(music)}).`);
  const effects = providerNamesOf(generated, 'sfx');
  if (effects.length > 0) sentences.push(`Also makes sound effects (${joinWithOr(effects)}).`);
  return sentences.join(' ');
}

export interface GenerateAudioParams extends CommonParameters {
  type?: AudioType;
  mode?: AudioGenerationMode;
  prompt: string;
  provider?: 'openai' | 'elevenlabs' | 'google' | 'mistral' | 'openrouter';
  model?: string;
  voice?: string;
  durationSeconds?: number;
  instrumental?: boolean;
  loop?: boolean;
  outputPath: string;
  overwrite?: boolean;
}

export class GenerateAudioTool extends BaseTool<GenerateAudioParams, CommonResult> {
  private audioService: AudioGenerationService;
  private readonly llmSettings: LLMProviderSettings | null;
  private readonly appsSettings?: AppsSettings;

  constructor(dependencies: {
    app: App;
    vault: Vault;
    llmSettings: LLMProviderSettings | null;
    appsSettings?: AppsSettings;
  }) {
    super(
      'generateAudio',
      'Generate Audio',
      buildGenerateAudioDescription(dependencies.llmSettings, dependencies.appsSettings),
      '1.0.0'
    );

    this.llmSettings = dependencies.llmSettings;
    this.appsSettings = dependencies.appsSettings;
    this.audioService = new AudioGenerationService(dependencies.app, dependencies.vault, {
      llmSettings: dependencies.llmSettings,
      appsSettings: dependencies.appsSettings,
    });
  }

  async execute(params: GenerateAudioParams): Promise<CommonResult> {
    try {
      const result = await this.audioService.generate({
        type: params.type,
        mode: params.mode,
        prompt: params.prompt,
        provider: params.provider,
        model: params.model,
        voice: params.voice,
        durationSeconds: params.durationSeconds,
        instrumental: params.instrumental,
        loop: params.loop,
        outputPath: params.outputPath,
        overwrite: params.overwrite,
      });

      return this.prepareResult(true, result);
    } catch (error) {
      return this.prepareResult(
        false,
        undefined,
        `Audio generation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelNamed(verbs('Generating audio', 'Generated audio', 'Failed to generate audio'), params, tense, ['prompt']);
  }

  /** Names what omitting a voice will really do, because Voice settings decide it. */
  private describeVoice(): string {
    const selection = resolveDefaultSpeechSelection(
      this.llmSettings,
      buildSpeechProviderAvailability(this.llmSettings, getSpeechAppCapabilityStates(this.appsSettings))
    );
    const fallback = selection.status === 'resolved' && selection.voice
      ? `Omit it to use the default from Voice settings, currently ${selection.voice} on ${selection.model}.`
      : 'Omit it to use the default from Voice settings.';
    return `Optional voice. ${fallback} Voices differ by model and one from another model usually fails, so call listVoices to see what a model takes.`;
  }

  /** Each model returns one file type, and the path has to match it. */
  private describeOutputPath(models: SpeechModelDeclaration[], providers: SpeechProvider[], hasMusicOrEffects: boolean): string {
    const extensionOf = (model: SpeechModelDeclaration) => getSpeechOutputExtension(model.provider, model.id);
    const all = new Set([...providers.map(provider => SPEECH_OUTPUT_EXTENSION[provider]), ...models.map(extensionOf)]);
    if (all.size === 1) {
      return `Vault-relative output path for the generated audio file, ending in .${Array.from(all)[0]}.${!all.has('mp3') && hasMusicOrEffects ? ' Music ends in .mp3.' : ''}`;
    }
    // Name only the exceptions: a gateway's full list would drown the rule.
    const rules = providers.map(provider => {
      const usual = SPEECH_OUTPUT_EXTENSION[provider];
      const exceptions = models.filter(model => model.provider === provider && extensionOf(model) !== usual);
      return `.${usual} on ${provider}${exceptions.length > 0 ? ` except .${extensionOf(exceptions[0])} for ${exceptions.map(model => model.id).join(', ')}` : ''}`;
    });
    return `Vault-relative output path for the generated audio file. The extension must match the model: ${rules.join('; ')}.${hasMusicOrEffects ? ' Music and sound effects end in .mp3.' : ''}`;
  }

  /** Options for music and sfx, shown only when a configured model takes them. */
  private buildTypeProperties(types: AudioType[], generated: GeneratedAudioModelDeclaration[]): Record<string, unknown> {
    if (generated.length === 0) return {};
    const describeDuration = (model: GeneratedAudioModelDeclaration): string => {
      const { duration } = model;
      // Measured: 3, 8 and 15 seconds of music landed, but 4 came back as 6.
      if (duration.control === 'parameter') return `${duration.minSeconds}-${duration.maxSeconds}s, usually close`;
      // Measured: lyria-3.5 asked for 25 seconds made 61.
      return duration.control === 'fixed' ? `always ${duration.seconds}s` : 'requested in the prompt, so it can be far off';
    };
    const describeInstrumental = (model: GeneratedAudioModelDeclaration) => model.instrumental === 'parameter' ? 'guaranteed' : 'requested in the prompt';
    const music = generated.filter(model => model.instrumental);
    const looping = generated.filter(model => model.supportsLoop);
    return {
      type: {
        type: 'string',
        enum: types,
        default: 'speech',
        description: 'What to generate. speech reads text aloud, music makes a track, sfx makes a sound effect.',
      },
      durationSeconds: {
        type: 'number',
        description: `Optional length for music or sfx, in seconds. If omitted, the model decides. ${groupModels(generated, describeDuration)}`,
      },
      ...(music.length > 0 ? {
        instrumental: {
          type: 'boolean',
          description: `Music with no vocals. ${groupModels(music, describeInstrumental)}`,
        },
      } : {}),
      ...(looping.length > 0 ? {
        loop: {
          type: 'boolean',
          description: `Make a sound effect that loops smoothly. Only on ${describeModelsByProvider(looping)}`,
        },
      } : {}),
    };
  }

  private describePrompt(models: SpeechModelDeclaration[], hasMusicOrEffects: boolean): string {
    const limit = (model: SpeechModelDeclaration) => model.maxInputTokens
      ? `${model.maxInputTokens} tokens`
      : model.maxInputChars ? `${model.maxInputChars} characters` : '';
    const limited = models.filter(limit);
    const limits = limited.length > 0 ? ` Longest input: ${groupModels(limited, limit)}.` : '';
    return `${hasMusicOrEffects ? 'For speech, the text to read aloud. For music or sfx, a description of the sound.' : 'Text to convert into voice audio.'}${limits}`;
  }

  getParameterSchema(): JSONSchema {
    const available = listConfiguredSpeechProviders(this.llmSettings, this.appsSettings);
    const providers = available.map(item => item.provider);
    const models = available.flatMap(item => item.models ?? []).filter(model => !model.deprecated);
    const generated = listConfiguredGeneratedAudioModels(this.llmSettings, this.appsSettings);
    const types: AudioType[] = [
      'speech',
      ...(generated.some(model => model.type === 'music') ? ['music' as const] : []),
      ...(generated.some(model => model.type === 'sfx') ? ['sfx' as const] : []),
    ];

    return this.getMergedSchema({
      type: 'object',
      properties: {
        ...this.buildTypeProperties(types, generated),
        prompt: {
          type: 'string',
          description: this.describePrompt(models, generated.length > 0),
        },
        provider: {
          type: 'string',
          ...(providers.length > 0 ? { enum: providers } : {}),
          description: 'Optional speech provider. Defaults to Voice settings.',
        },
        model: {
          type: 'string',
          // OpenRouter serves whatever its speech listing holds, so its ids stay open.
          ...(models.length > 0 && !providers.includes('openrouter')
            ? { enum: Array.from(new Set([...models, ...generated].map(model => model.id))) }
            : {}),
          description: [
            'Optional model ID. Speech defaults to Voice settings or the provider default.',
            ...(models.length > 0 ? [`Speech: ${describeModelsByProvider(models)}.`] : []),
            ...(providers.includes('openrouter') ? ['OpenRouter also takes any other speech model it lists.'] : []),
            ...(generated.some(model => model.type === 'music') ? [`Music: ${describeModelsByProvider(generated.filter(model => model.type === 'music'))}.`] : []),
            ...(generated.some(model => model.type === 'sfx') ? [`Sound effects: ${describeModelsByProvider(generated.filter(model => model.type === 'sfx'))}.`] : []),
          ].join(' '),
        },
        voice: {
          type: 'string',
          description: `${generated.length > 0 ? 'For speech only. ' : ''}${this.describeVoice()}`,
        },
        outputPath: {
          type: 'string',
          description: this.describeOutputPath(models, providers, generated.length > 0),
        },
        overwrite: {
          type: 'boolean',
          description: 'If true, replace an existing file at outputPath. Default: false.',
        },
      },
      required: ['prompt', 'outputPath'],
    });
  }
}
