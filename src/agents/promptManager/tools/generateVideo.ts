import { App, Vault } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { CommonParameters, CommonResult } from '../../../types';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import { labelNamed, verbs } from '../../utils/toolStatusLabels';
import type { ToolStatusTense } from '../../interfaces/ITool';
import type { LLMProviderSettings } from '../../../types/llm/ProviderTypes';
import type { VideoAspectRatio, VideoProvider, VideoResolution } from '../../../services/llm/types/VideoTypes';
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

export class GenerateVideoTool extends BaseTool<GenerateVideoParams, CommonResult> {
  private videoService: VideoGenerationService;
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
      'Generate text-to-video MP4 files in the vault using Google Veo or OpenRouter video models.',
      '1.0.0'
    );

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

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Text description of the video to generate.',
        },
        provider: {
          type: 'string',
          enum: ['google', 'openrouter'],
          description: 'Optional video provider. Defaults to Video generation settings.',
        },
        model: {
          type: 'string',
          description: 'Optional video model ID. Defaults to Video generation settings or the first available model for the provider.',
        },
        outputPath: {
          type: 'string',
          description: 'Vault-relative output path for the generated MP4 file, ending in .mp4.',
        },
        overwrite: {
          type: 'boolean',
          description: 'If true, replace an existing file at outputPath. Default: false.',
        },
        aspectRatio: {
          type: 'string',
          enum: ['16:9', '9:16', '1:1'],
          description: 'Optional output aspect ratio. Defaults to Video generation settings or model default.',
        },
        resolution: {
          type: 'string',
          enum: ['720p', '1080p', '4k'],
          description: 'Optional output resolution. Defaults to Video generation settings or model default.',
        },
        seconds: {
          type: 'number',
          description: 'Optional clip duration in seconds. Provider/model support varies.',
        },
        referenceImage: {
          type: 'string',
          description: 'Optional vault-relative image path to guide image-to-video or reference-to-video generation.',
        },
        generateAudio: {
          type: 'boolean',
          description: 'Whether to ask the provider to generate audio when the selected model supports it.',
        },
        negativePrompt: {
          type: 'string',
          description: 'Optional negative prompt for providers/models that support it.',
        },
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
