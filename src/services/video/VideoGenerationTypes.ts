import type { VideoAspectRatio, VideoProvider, VideoResolution } from '../llm/types/VideoTypes';

export interface GenerateVideoRequest {
  prompt: string;
  provider?: string;
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

export interface ResolvedVideoGenerationRequest {
  prompt: string;
  provider: VideoProvider;
  model: string;
  aspectRatio: VideoAspectRatio;
  resolution: VideoResolution;
  seconds?: number;
  referenceImage?: string;
  generateAudio?: boolean;
  negativePrompt?: string;
  pollIntervalMs: number;
  timeoutMs: number;
}

export interface VideoGenerationAdapterResult {
  videoData: ArrayBuffer;
  mimeType: 'video/mp4';
  providerJobId?: string;
  pollingUrl?: string;
  durationSeconds?: number;
}

export interface GenerateVideoResult {
  status: 'completed';
  path: string;
  provider: VideoProvider;
  model: string;
  mimeType: 'video/mp4';
  promptLength: number;
  videoSize: number;
  durationSeconds?: number;
  aspectRatio: VideoAspectRatio;
  resolution: VideoResolution;
  providerJobId?: string;
  pollingUrl?: string;
  note: string;
}

export interface PendingVideoGenerationJob {
  provider: VideoProvider;
  model?: string;
  outputPath: string;
  providerJobId: string;
  pollingUrl?: string;
  overwrite?: boolean;
  request?: {
    seconds?: number;
    aspectRatio?: VideoAspectRatio;
    resolution?: VideoResolution;
  };
}

export interface VideoGenerationCheckOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface PendingVideoGenerationResult {
  status: 'in_progress';
  path: string;
  provider: VideoProvider;
  model?: string;
  providerJobId: string;
  pollingUrl?: string;
  note: string;
}

export interface FailedVideoGenerationResult {
  status: 'failed';
  path: string;
  provider: VideoProvider;
  model?: string;
  providerJobId: string;
  pollingUrl?: string;
  error: string;
  note: string;
}

export type VideoGenerationFinalizeResult =
  | GenerateVideoResult
  | PendingVideoGenerationResult
  | FailedVideoGenerationResult;

export type VideoGenerationJobCheck =
  | {
    status: 'completed';
    result: VideoGenerationAdapterResult;
  }
  | {
    status: 'in_progress';
    providerJobId?: string;
    pollingUrl?: string;
  }
  | {
    status: 'failed';
    providerJobId?: string;
    pollingUrl?: string;
    error: string;
  };

export interface VideoGenerationAdapter {
  readonly provider: VideoProvider;
  isAvailable(): boolean;
  generate(request: ResolvedVideoGenerationRequest): Promise<VideoGenerationAdapterResult>;
  checkJob(job: PendingVideoGenerationJob): Promise<VideoGenerationJobCheck>;
}

export class VideoGenerationTimeoutError extends Error {
  constructor(
    message: string,
    public readonly details: {
      provider: VideoProvider;
      model?: string;
      providerJobId?: string;
      pollingUrl?: string;
      timeoutMs: number;
      outputPath?: string;
      request?: {
        seconds?: number;
        aspectRatio?: VideoAspectRatio;
        resolution?: VideoResolution;
      };
    }
  ) {
    super(message);
    this.name = 'VideoGenerationTimeoutError';
  }

  withOutputPath(outputPath: string): VideoGenerationTimeoutError {
    return new VideoGenerationTimeoutError(this.message, {
      ...this.details,
      outputPath,
    });
  }
}
