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
  listConfiguredSpeechProviders,
  SPEECH_OUTPUT_EXTENSION,
  type SpeechModelDeclaration,
  type SpeechProvider
} from '../../../services/llm/types/SpeechTypes';
import { describeModelsByProvider, groupModels, joinWithOr } from '../../../services/llm/mediaModelText';

const PROVIDER_NAMES: Record<SpeechProvider, string> = {
  elevenlabs: 'ElevenLabs',
  openai: 'OpenAI',
  google: 'Google',
  mistral: 'Mistral',
  openrouter: 'OpenRouter'
};

/**
 * The one-line description an agent sees before it asks for the full schema.
 * Written only from the providers that have a key.
 */
export function buildGenerateAudioDescription(
  llmSettings: LLMProviderSettings | null | undefined,
  appsSettings?: AppsSettings | null
): string {
  const names = listConfiguredSpeechProviders(llmSettings, appsSettings).map(item => PROVIDER_NAMES[item.provider]);
  return names.length > 0
    ? `Generate voice audio files in the vault from text, using configured Voice settings or ${joinWithOr(names)} speech.`
    : 'Generate voice audio files in the vault from text.';
}

export interface GenerateAudioParams extends CommonParameters {
  mode?: AudioGenerationMode;
  prompt: string;
  provider?: 'openai' | 'elevenlabs' | 'google' | 'mistral' | 'openrouter';
  model?: string;
  voice?: string;
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
        mode: params.mode,
        prompt: params.prompt,
        provider: params.provider,
        model: params.model,
        voice: params.voice,
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

  /** Which voices each configured model takes, from the catalog. */
  private describeVoices(models: SpeechModelDeclaration[], providers: SpeechProvider[]): string {
    const listed = models.filter(model => model.voices?.length);
    const open = models.filter(model => !model.voices?.length);
    return [
      'Optional voice. Defaults to Voice settings or the model default.',
      ...(listed.length > 0 ? [`Accepted: ${groupModels(listed, model => (model.voices ?? []).map(voice => voice.id).join(', '))}.`] : []),
      ...(open.length > 0 ? [`Use a voice ID from the provider on ${describeModelsByProvider(open)}.`] : []),
      ...(providers.includes('elevenlabs') ? ['ElevenLabs voice IDs come from its listVoices tool.'] : []),
    ].join(' ');
  }

  /** Each provider returns one file type, and the path has to match it. */
  private describeOutputPath(providers: SpeechProvider[]): string {
    const extensions = Array.from(new Set(providers.map(provider => SPEECH_OUTPUT_EXTENSION[provider])));
    if (extensions.length === 1) {
      return `Vault-relative output path for the generated audio file, ending in .${extensions[0]}.`;
    }
    const perExtension = extensions.map(extension => {
      const matching = providers.filter(provider => SPEECH_OUTPUT_EXTENSION[provider] === extension);
      return `.${extension} on ${matching.join(', ')}`;
    });
    return `Vault-relative output path for the generated audio file. The extension must match the provider: ${perExtension.join('; ')}.`;
  }

  private describePrompt(models: SpeechModelDeclaration[]): string {
    const limit = (model: SpeechModelDeclaration) => model.maxInputTokens
      ? `${model.maxInputTokens} tokens`
      : model.maxInputChars ? `${model.maxInputChars} characters` : '';
    const limited = models.filter(limit);
    const limits = limited.length > 0 ? ` Longest input: ${groupModels(limited, limit)}.` : '';
    return `Text to convert into voice audio.${limits}`;
  }

  getParameterSchema(): JSONSchema {
    const available = listConfiguredSpeechProviders(this.llmSettings, this.appsSettings);
    const providers = available.map(item => item.provider);
    const models = available.flatMap(item => item.models ?? []).filter(model => !model.deprecated);

    return this.getMergedSchema({
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['voice'],
          description: 'Audio generation mode. Only voice is available.',
        },
        prompt: {
          type: 'string',
          description: this.describePrompt(models),
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
            ? { enum: Array.from(new Set(models.map(model => model.id))) }
            : {}),
          description: [
            'Optional speech model ID. Defaults to Voice settings or the provider default.',
            ...(models.length > 0 ? [`Available: ${describeModelsByProvider(models)}.`] : []),
            ...(providers.includes('openrouter') ? ['OpenRouter also takes any other speech model it lists.'] : []),
          ].join(' '),
        },
        voice: {
          type: 'string',
          description: this.describeVoices(models, providers),
        },
        outputPath: {
          type: 'string',
          description: this.describeOutputPath(providers),
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
