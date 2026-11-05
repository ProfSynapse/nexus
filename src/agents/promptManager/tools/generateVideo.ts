import { App, Vault } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { CommonParameters, CommonResult } from '../../../types';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import { labelNamed, verbs } from '../../utils/toolStatusLabels';
import type { ToolStatusTense } from '../../interfaces/ITool';
import type { LLMProviderSettings } from '../../../types/llm/ProviderTypes';
import type { VideoAspectRatio, VideoModelDeclaration, VideoProvider, VideoResolution } from '../../../services/llm/types/VideoTypes';
import { listConfiguredVideoModels } from '../../../services/llm/types/VideoTypes';
import { describeModelsByProvider, groupModels } from '../../../services/llm/mediaModelText';
import { VideoGenerationService } from '../../../services/video/VideoGenerationService';
import { VideoGenerationTimeoutError } from '../../../services/video/VideoGenerationTypes';
import { ArtifactJobStore } from '../../../services/artifacts/ArtifactJobStore';

export interface GenerateVideoParams extends CommonParameters {
  prompt: string;
  provider?: VideoProvider;
  model?: string;
  outputPath: string;
  overwrite?: boolean;
  aspectRatio?: VideoAspectRatio;
  resolution?: VideoResolution;
  seconds?: number;
  referenceImage?: string;
  generateAudio?: boolean;
  negativePrompt?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

const ASPECT_RATIO_ORDER: VideoAspectRatio[] = ['16:9', '9:16', '1:1'];
const RESOLUTION_ORDER: VideoResolution[] = ['360p', '720p', '1080p', '2k', '4k'];

/** "3-10" for a run of whole seconds, otherwise "4, 6, 8". */
function formatDurations(durations: number[]): string {
  const sorted = [...durations].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return sorted.length > 2 && last - first === sorted.length - 1 ? `${first}-${last}` : sorted.join(', ');
}

/**
 * The one-line description an agent sees before it asks for the full schema.
 * Written only from the models a provider with a key can serve.
 */
export function buildGenerateVideoDescription(settings: LLMProviderSettings | null | undefined): string {
  const models = listConfiguredVideoModels(settings);
  const direct = models.filter(model => model.provider === 'google').map(model => `Google ${model.name}`);
  const sources = [...direct, ...(models.some(model => model.provider === 'openrouter') ? ['OpenRouter video models'] : [])];
  const reference = models.some(model => model.supportsReferenceImage) ? ', optionally guided by a reference image,' : '';
  const using = sources.length > 0 ? ` using ${sources.join(' or ')}` : '';
  return `Generate MP4 video files in the vault from a text prompt${reference}${using}.`;
}

export class GenerateVideoTool extends BaseTool<GenerateVideoParams, CommonResult> {
  private videoService: VideoGenerationService;
  private readonly llmSettings: LLMProviderSettings | null;
  private jobStore: ArtifactJobStore;

  constructor(dependencies: {
    app: App;
    vault: Vault;
    llmSettings: LLMProviderSettings | null;
    artifactJobsPath?: string;
  }) {
    super(
      'generateVideo',
      'Generate Video',
      buildGenerateVideoDescription(dependencies.llmSettings),
      '1.0.0'
    );

    this.llmSettings = dependencies.llmSettings;
    this.videoService = new VideoGenerationService(dependencies.app, dependencies.vault, {
      llmSettings: dependencies.llmSettings,
    });
    this.jobStore = new ArtifactJobStore(dependencies.vault, dependencies.artifactJobsPath);
  }

  async execute(params: GenerateVideoParams): Promise<CommonResult> {
    try {
      const result = await this.videoService.generate({
        prompt: params.prompt,
        provider: params.provider,
        model: params.model,
        outputPath: params.outputPath,
        overwrite: params.overwrite,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        seconds: params.seconds,
        referenceImage: params.referenceImage,
        generateAudio: params.generateAudio,
        negativePrompt: params.negativePrompt,
        pollIntervalMs: params.pollIntervalMs,
        timeoutMs: params.timeoutMs,
      });

      return this.prepareResult(true, result);
    } catch (error) {
      if (error instanceof VideoGenerationTimeoutError) {
        const outputPath = error.details.outputPath || params.outputPath;
        const job = error.details.providerJobId
          ? await this.jobStore.create({
            kind: 'video',
            provider: error.details.provider,
            model: error.details.model || params.model,
            providerJobId: error.details.providerJobId,
            pollingUrl: error.details.pollingUrl,
            outputPath,
            overwrite: params.overwrite === true,
            promptPreview: params.prompt.slice(0, 240),
            request: error.details.request,
          })
          : null;

        return this.prepareResult(
          false,
          {
            status: 'in_progress',
            jobId: job?.id,
            path: outputPath,
            provider: error.details.provider,
            model: error.details.model || params.model,
            providerJobId: error.details.providerJobId,
            pollingUrl: error.details.pollingUrl,
            timeoutMs: error.details.timeoutMs,
            note: job
              ? `Video generation is still running. The requested output path is ${outputPath}; call checkGeneratedArtifact with jobId ${job.id} to save the completed media there.`
              : `Video generation is still running. The requested output path is ${outputPath}; keep the provider job details so a follow-up status check can save the completed media there.`,
          },
          `Video generation is still running: ${error.message}`
        );
      }

      return this.prepareResult(
        false,
        undefined,
        `Video generation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelNamed(verbs('Generating video', 'Generated video', 'Failed to generate video'), params, tense, ['prompt']);
  }

  /** Options that vary by model, each shown only when a configured model takes it. */
  private buildCapabilityProperties(models: VideoModelDeclaration[]): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    if (models.length === 0) return properties;

    properties.aspectRatio = {
      type: 'string',
      enum: ASPECT_RATIO_ORDER.filter(ratio => models.some(model => model.aspectRatios.includes(ratio))),
      description: `Optional output aspect ratio. Defaults to Video generation settings or model default. Supported per model: ${groupModels(models, model => model.aspectRatios.join(', '))}`,
    };
    properties.resolution = {
      type: 'string',
      enum: RESOLUTION_ORDER.filter(resolution => models.some(model => model.resolutions.includes(resolution))),
      description: `Optional output resolution. Defaults to Video generation settings or model default. Supported per model: ${groupModels(models, model => model.resolutions.join(', '))}`,
    };

    const withDurations = models.filter(model => model.durations?.length);
    properties.seconds = {
      type: 'number',
      description: `Optional clip duration in seconds. Supported per model: ${groupModels(withDurations, model => `${formatDurations(model.durations ?? [])}s`)}`,
    };

    const withReference = models.filter(model => model.supportsReferenceImage);
    if (withReference.length > 0) {
      properties.referenceImage = {
        type: 'string',
        description: `Optional vault-relative image path to guide image-to-video or reference-to-video generation. Only on ${describeModelsByProvider(withReference)}`,
      };
    }

    const withAudio = models.filter(model => model.supportsAudioPrompting && !model.audioAlwaysOn);
    const alwaysAudio = models.filter(model => model.audioAlwaysOn);
    if (withAudio.length > 0 || alwaysAudio.length > 0) {
      const notes = [
        ...(withAudio.length > 0 ? [`Can be set on ${describeModelsByProvider(withAudio)}.`] : []),
        ...(alwaysAudio.length > 0 ? [`Always on, and false is rejected, on ${describeModelsByProvider(alwaysAudio)}.`] : []),
      ];
      properties.generateAudio = {
        type: 'boolean',
        description: `Whether to ask the provider to generate audio. ${notes.join(' ')}`,
      };
    }

    const nativeNegative = models.filter(model => model.negativePrompt === 'native');
    const appendedNegative = models.filter(model => model.negativePrompt === 'appended');
    if (nativeNegative.length > 0 || appendedNegative.length > 0) {
      const notes = [
        ...(nativeNegative.length > 0 ? [`Sent to ${describeModelsByProvider(nativeNegative)}.`] : []),
        ...(appendedNegative.length > 0 ? [`Added to the prompt as "Do not include: ..." on ${describeModelsByProvider(appendedNegative)}.`] : []),
      ];
      properties.negativePrompt = {
        type: 'string',
        description: `Optional things to leave out. Other models reject it. ${notes.join(' ')}`,
      };
    }

    return properties;
  }

  getParameterSchema(): JSONSchema {
    const models = listConfiguredVideoModels(this.llmSettings);
    const providers = Array.from(new Set(models.map(model => model.provider)));

    return this.getMergedSchema({
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Text description of the video to generate.',
        },
        provider: {
          type: 'string',
          ...(providers.length > 0 ? { enum: providers } : {}),
          description: 'Optional video provider. Defaults to Video generation settings.',
        },
        model: {
          type: 'string',
          ...(models.length > 0 ? { enum: Array.from(new Set(models.map(model => model.id))) } : {}),
          description: `Optional video model ID. Defaults to Video generation settings or the first available model for the provider. Available: ${describeModelsByProvider(models)}`,
        },
        outputPath: {
          type: 'string',
          description: 'Vault-relative output path for the generated MP4 file, ending in .mp4.',
        },
        overwrite: {
          type: 'boolean',
          description: 'If true, replace an existing file at outputPath. Default: false.',
        },
        ...this.buildCapabilityProperties(models),
        pollIntervalMs: {
          type: 'number',
          description: 'Optional polling interval for asynchronous jobs. Default: 10000.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Optional timeout for asynchronous jobs. Default: 600000.',
        },
      },
      required: ['prompt', 'outputPath'],
    });
  }
}
