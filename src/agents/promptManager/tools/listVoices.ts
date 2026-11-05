import { BaseTool } from '../../baseTool';
import { CommonParameters, CommonResult } from '../../../types';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import { labelNamed, verbs } from '../../utils/toolStatusLabels';
import type { ToolStatusTense } from '../../interfaces/ITool';
import type { AppsSettings } from '../../../types/apps/AppTypes';
import type { LLMProviderSettings } from '../../../types/llm/ProviderTypes';
import { listConfiguredSpeechProviders } from '../../../services/llm/types/SpeechTypes';
import { SpeechSynthesisService } from '../../../services/readAloud/SpeechSynthesisService';
import { VoiceCatalogService } from '../../../services/readAloud/VoiceCatalogService';

export interface ListVoicesParams extends CommonParameters {
  provider?: string;
  model?: string;
  search?: string;
}

/** A provider library can run to thousands of voices, which no agent should read whole. */
const MAX_VOICES = 200;

/**
 * Lists a speech model's voices from the catalog that fills the Voice settings
 * picker, and reports the default generateAudio would really use, because both
 * come from the same services.
 */
export class ListVoicesTool extends BaseTool<ListVoicesParams, CommonResult> {
  private readonly catalog = new VoiceCatalogService();
  private readonly speech: SpeechSynthesisService;

  constructor(private readonly dependencies: {
    llmSettings: LLMProviderSettings | null;
    appsSettings?: AppsSettings;
  }) {
    super(
      'listVoices',
      'List Voices',
      'List the voices a speech model takes, and which one is the default from Voice settings. Use before choosing a voice for generateAudio.',
      '1.0.0'
    );
    this.speech = new SpeechSynthesisService(dependencies.llmSettings, { appsSettings: dependencies.appsSettings });
  }

  async execute(params: ListVoicesParams): Promise<CommonResult> {
    try {
      const { provider, model, voice: defaultVoice } = this.speech.resolveRequest({
        text: '',
        provider: params.provider,
        model: params.model,
      });

      const voices = await this.catalog.getVoices(provider, model, {
        llmSettings: this.dependencies.llmSettings ?? undefined,
        appsSettings: this.dependencies.appsSettings,
      });

      const search = params.search?.trim().toLowerCase();
      const matching = search
        ? voices.filter(voice => `${voice.id} ${voice.name} ${voice.description ?? ''}`.toLowerCase().includes(search))
        : voices;
      const notes = [
        ...(matching.length > MAX_VOICES ? [`Showing the first ${MAX_VOICES} of ${matching.length}. Use search to narrow this down.`] : []),
        ...(voices.length === 0 ? [`${model} lists no voices to choose from, so leave voice out.`] : []),
      ];

      return this.prepareResult(true, {
        provider,
        model,
        defaultVoice: defaultVoice || undefined,
        count: matching.length,
        voices: matching.slice(0, MAX_VOICES).map(voice => ({
          id: voice.id,
          name: voice.name,
          ...(voice.description ? { description: voice.description } : {}),
          ...(voice.id === defaultVoice ? { isDefault: true } : {}),
        })),
        ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
      });
    } catch (error) {
      return this.prepareResult(false, undefined, `Could not list voices: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelNamed(verbs('Listing voices', 'Listed voices', 'Failed to list voices'), params, tense, ['model', 'provider']);
  }

  getParameterSchema(): JSONSchema {
    const providers = listConfiguredSpeechProviders(this.dependencies.llmSettings, this.dependencies.appsSettings)
      .map(item => item.provider);
    return this.getMergedSchema({
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          ...(providers.length > 0 ? { enum: providers } : {}),
          description: 'Optional speech provider. Defaults to Voice settings.',
        },
        model: {
          type: 'string',
          description: 'Optional speech model ID, which needs provider too. Defaults to Voice settings or the provider default. Voices differ by model.',
        },
        search: {
          type: 'string',
          description: 'Optional text to match in a voice name, ID or description.',
        },
      },
    });
  }
}
