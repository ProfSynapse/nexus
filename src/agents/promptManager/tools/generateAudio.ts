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

  constructor(dependencies: {
    app: App;
    vault: Vault;
    llmSettings: LLMProviderSettings | null;
    appsSettings?: AppsSettings;
  }) {
    super(
      'generateAudio',
      'Generate Audio',
      'Generate audio files in the vault. Supports voice mode using configured Voice settings, OpenAI, ElevenLabs, Google, Mistral, or OpenRouter speech.',
      '1.0.0'
    );

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

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['voice'],
          description: 'Audio generation mode. Voice is currently supported; music and sfx will be unlocked by provider capability in a later phase.',
        },
        prompt: {
          type: 'string',
          description: 'Text to convert into voice audio.',
        },
        provider: {
          type: 'string',
          enum: ['openai', 'elevenlabs', 'google', 'mistral', 'openrouter'],
          description: 'Optional speech provider. Defaults to Voice settings.',
        },
        model: {
          type: 'string',
          description: 'Optional speech model ID. Defaults to Voice settings or the provider default.',
        },
        voice: {
          type: 'string',
          description: 'Optional provider voice ID. Defaults to Voice settings or the model default.',
        },
        outputPath: {
          type: 'string',
          description: 'Vault-relative output path for the generated audio file, usually ending in .mp3.',
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
