import { App, Vault } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { CommonParameters, CommonResult } from '../../../types';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import type { ToolStatusTense } from '../../interfaces/ITool';
import { verbs } from '../../utils/toolStatusLabels';
import type { LLMProviderSettings } from '../../../types/llm/ProviderTypes';
import { ArtifactJobStore } from '../../../services/artifacts/ArtifactJobStore';
import { VideoGenerationService } from '../../../services/video/VideoGenerationService';
import type { PendingVideoGenerationJob } from '../../../services/video/VideoGenerationTypes';
import type { VideoAspectRatio, VideoProvider, VideoResolution } from '../../../services/llm/types/VideoTypes';

export interface CheckGeneratedArtifactParams extends CommonParameters {
  jobId: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export class CheckGeneratedArtifactTool extends BaseTool<CheckGeneratedArtifactParams, CommonResult> {
  private readonly jobStore: ArtifactJobStore;
  private readonly videoService: VideoGenerationService;

  constructor(dependencies: {
    app: App;
    vault: Vault;
    llmSettings: LLMProviderSettings | null;
    artifactJobsPath?: string;
  }) {
    super(
      'checkGeneratedArtifact',
      'Check Generated Artifact',
      'Check a previously timed-out generated artifact job and save the completed output to its requested vault path.',
      '1.0.0'
    );

    this.jobStore = new ArtifactJobStore(dependencies.vault, dependencies.artifactJobsPath);
    this.videoService = new VideoGenerationService(dependencies.app, dependencies.vault, {
      llmSettings: dependencies.llmSettings,
    });
  }

  async execute(params: CheckGeneratedArtifactParams): Promise<CommonResult> {
    try {
      const job = await this.jobStore.get(params.jobId);
      if (!job) {
        return this.prepareResult(false, undefined, `Generated artifact job not found: ${params.jobId}`);
      }

      if (job.kind !== 'video') {
        return this.prepareResult(false, undefined, `Generated artifact kind "${job.kind}" is not supported yet.`);
      }

      const provider = parseVideoProvider(job.provider);
      if (!provider) {
        return this.prepareResult(false, undefined, `Generated artifact provider "${job.provider}" is not supported for video jobs.`);
      }

      const result = await this.videoService.finalizePendingJob({
        provider,
        model: job.model,
        outputPath: job.outputPath,
        providerJobId: job.providerJobId,
        pollingUrl: job.pollingUrl,
        overwrite: job.overwrite,
        request: parseVideoRequest(job.request),
      }, {
        pollIntervalMs: params.pollIntervalMs,
        timeoutMs: params.timeoutMs,
      });

      const updated = await this.jobStore.update(job.id, {
        status: result.status,
        providerJobId: result.providerJobId,
        pollingUrl: result.pollingUrl,
        error: result.status === 'failed' ? result.error : undefined,
        result: result.status === 'completed' ? result as unknown as Record<string, unknown> : undefined,
      });

      const data = {
        ...result,
        jobId: updated.id,
      };

      return this.prepareResult(result.status !== 'failed', data, result.status === 'failed' ? result.error : undefined);
    } catch (error) {
      return this.prepareResult(
        false,
        undefined,
        `Generated artifact check failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getStatusLabel(_params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    const labels = verbs('Checking generated artifact', 'Checked generated artifact', 'Failed to check generated artifact');
    return labels[tense];
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'Nexus generated artifact job ID returned by a timed-out generation tool call.',
        },
        pollIntervalMs: {
          type: 'number',
          description: 'Optional polling interval while waiting for completion. Default: 5000.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Optional maximum time to wait in this status check. Default: 30000.',
        },
      },
      required: ['jobId'],
    });
  }
}

function parseVideoProvider(provider: string): VideoProvider | null {
  return provider === 'google' || provider === 'openrouter' ? provider : null;
}

function parseVideoRequest(request: Record<string, unknown> | undefined): PendingVideoGenerationJob['request'] {
  if (!request) {
    return undefined;
  }

  return {
    seconds: typeof request.seconds === 'number' ? request.seconds : undefined,
    aspectRatio: parseAspectRatio(request.aspectRatio),
    resolution: parseResolution(request.resolution),
  };
}

function parseAspectRatio(value: unknown): VideoAspectRatio | undefined {
  return value === '16:9' || value === '9:16' || value === '1:1' ? value : undefined;
}

function parseResolution(value: unknown): VideoResolution | undefined {
  return value === '720p' || value === '1080p' || value === '4k' ? value : undefined;
}
