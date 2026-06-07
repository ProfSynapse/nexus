import { requestUrl, Vault } from 'obsidian';
import { BRAND_NAME } from '../../../constants/branding';
import {
  getVideoModelsForProvider,
  type VideoAspectRatio,
  type VideoModelDeclaration,
  type VideoProvider,
  type VideoResolution,
} from '../../llm/types/VideoTypes';
import type {
  PendingVideoGenerationJob,
  ResolvedVideoGenerationRequest,
  VideoGenerationAdapter,
  VideoGenerationAdapterResult,
  VideoGenerationJobCheck,
} from '../VideoGenerationTypes';
import { VideoGenerationTimeoutError } from '../VideoGenerationTypes';
import {
  getNumber,
  getString,
  isRecord,
  loadReferenceImage,
  sleep,
} from './videoAdapterUtils';

export interface OpenRouterVideoAdapterConfig {
  apiKey: string;
  vault: Vault;
  httpReferer?: string;
  xTitle?: string;
}

interface OpenRouterVideoModelMetadata {
  id: string;
  name?: string;
  supported_resolutions?: string[];
  supported_aspect_ratios?: string[];
  supported_durations?: number[];
  generate_audio?: boolean;
}

interface OpenRouterVideoJob {
  id?: string;
  status?: string;
  polling_url?: string;
  unsigned_urls?: string[];
  output_url?: string;
  url?: string;
  error?: unknown;
}

export class OpenRouterVideoAdapter implements VideoGenerationAdapter {
  readonly provider: VideoProvider = 'openrouter';
  private readonly baseUrl = 'https://openrouter.ai/api/v1';
  private readonly httpReferer: string;
  private readonly xTitle: string;
  private modelCache: OpenRouterVideoModelMetadata[] | null = null;
  private modelCacheTimestamp = 0;
  private readonly cacheTtlMs = 10 * 60 * 1000;

  constructor(private config: OpenRouterVideoAdapterConfig) {
    this.httpReferer = config.httpReferer?.trim() || 'https://synapticlabs.ai';
    this.xTitle = config.xTitle?.trim() || BRAND_NAME;
  }

  isAvailable(): boolean {
    return this.config.apiKey.trim().length > 0;
  }

  async generate(request: ResolvedVideoGenerationRequest): Promise<VideoGenerationAdapterResult> {
    if (!this.isAvailable()) {
      throw new Error('OpenRouter video generation is not configured.');
    }

    await this.validateAgainstModelMetadata(request);

    const started = Date.now();
    let job = await this.submitJob(request);
    if (!job.id && !job.polling_url) {
      throw new Error('OpenRouter video generation did not return a job ID or polling URL.');
    }

    while (!this.isTerminalStatus(job.status)) {
      if (Date.now() - started > request.timeoutMs) {
        throw new VideoGenerationTimeoutError(
          `OpenRouter video generation timed out after ${Math.round(request.timeoutMs / 1000)} seconds. ` +
          `Job ID: ${job.id || 'unknown'}. Polling URL: ${job.polling_url || 'unknown'}.`,
          {
            provider: this.provider,
            model: request.model,
            providerJobId: job.id,
            pollingUrl: job.polling_url,
            timeoutMs: request.timeoutMs,
            request: {
              seconds: request.seconds,
              aspectRatio: request.aspectRatio,
              resolution: request.resolution,
            },
          }
        );
      }

      await sleep(request.pollIntervalMs);
      job = await this.pollJob(job);
    }

    if (job.status !== 'completed') {
      throw new Error(`OpenRouter video generation failed with status "${job.status || 'unknown'}": ${this.formatJobError(job.error)}`);
    }

    const videoData = await this.downloadVideo(job);
    return {
      videoData,
      mimeType: 'video/mp4',
      providerJobId: job.id,
      pollingUrl: job.polling_url,
      durationSeconds: request.seconds,
    };
  }

  async checkJob(job: PendingVideoGenerationJob): Promise<VideoGenerationJobCheck> {
    if (!this.isAvailable()) {
      throw new Error('OpenRouter video generation is not configured.');
    }

    const providerJob: OpenRouterVideoJob = {
      id: job.providerJobId,
      polling_url: job.pollingUrl,
    };
    const current = await this.pollJob(providerJob);

    if (!this.isTerminalStatus(current.status)) {
      return {
        status: 'in_progress',
        providerJobId: current.id || job.providerJobId,
        pollingUrl: current.polling_url || job.pollingUrl,
      };
    }

    if (current.status !== 'completed') {
      return {
        status: 'failed',
        providerJobId: current.id || job.providerJobId,
        pollingUrl: current.polling_url || job.pollingUrl,
        error: `OpenRouter video generation failed with status "${current.status || 'unknown'}": ${this.formatJobError(current.error)}`,
      };
    }

    const videoData = await this.downloadVideo(current);
    return {
      status: 'completed',
      result: {
        videoData,
        mimeType: 'video/mp4',
        providerJobId: current.id || job.providerJobId,
        pollingUrl: current.polling_url || job.pollingUrl,
        durationSeconds: job.request?.seconds,
      },
    };
  }

  async listModels(): Promise<VideoModelDeclaration[]> {
    const metadata = await this.fetchModelMetadata();
    return metadata.map(model => ({
      provider: 'openrouter',
      id: model.id,
      name: model.name || model.id,
      execution: 'long-running-operation',
      supportsReferenceImage: true,
      supportsAudioPrompting: model.generate_audio === true,
      aspectRatios: this.asAspectRatios(model.supported_aspect_ratios),
      resolutions: this.asResolutions(model.supported_resolutions),
      durations: model.supported_durations,
      defaultAspectRatio: this.asAspectRatios(model.supported_aspect_ratios)[0] || '16:9',
      defaultResolution: this.asResolutions(model.supported_resolutions)[0] || '720p',
    }));
  }

  private async validateAgainstModelMetadata(request: ResolvedVideoGenerationRequest): Promise<void> {
    const models = await this.fetchModelMetadata();
    const model = models.find(candidate => candidate.id === request.model);
    if (!model) {
      return;
    }

    const supportedResolutions = this.asResolutions(model.supported_resolutions);
    if (supportedResolutions.length && !supportedResolutions.includes(request.resolution)) {
      throw new Error(`OpenRouter model "${request.model}" does not support resolution "${request.resolution}". Supported: ${supportedResolutions.join(', ')}.`);
    }

    if (model.supported_aspect_ratios?.length && !model.supported_aspect_ratios.includes(request.aspectRatio)) {
      throw new Error(`OpenRouter model "${request.model}" does not support aspect ratio "${request.aspectRatio}". Supported: ${model.supported_aspect_ratios.join(', ')}.`);
    }

    if (request.seconds && model.supported_durations?.length && !model.supported_durations.includes(request.seconds)) {
      throw new Error(`OpenRouter model "${request.model}" does not support ${request.seconds}-second clips. Supported durations: ${model.supported_durations.join(', ')}.`);
    }
  }

  private async submitJob(request: ResolvedVideoGenerationRequest): Promise<OpenRouterVideoJob> {
    const body: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt,
      resolution: request.resolution,
      aspect_ratio: request.aspectRatio,
    };

    if (request.seconds) {
      body.duration = request.seconds;
    }

    if (request.generateAudio !== undefined) {
      body.generate_audio = request.generateAudio;
    }

    if (request.negativePrompt) {
      body.negative_prompt = request.negativePrompt;
    }

    if (request.referenceImage) {
      const image = await loadReferenceImage(this.config.vault, request.referenceImage);
      body.input_references = [
        {
          type: 'image_url',
          image_url: {
            url: `data:${image.mimeType};base64,${image.data}`,
          },
        },
      ];
    }

    const response = await requestUrl({
      url: `${this.baseUrl}/videos`,
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OpenRouter video generation failed: HTTP ${response.status}: ${response.text || 'Unknown error'}`);
    }

    return this.asJob(response.json);
  }

  private async pollJob(job: OpenRouterVideoJob): Promise<OpenRouterVideoJob> {
    const url = job.polling_url || `${this.baseUrl}/videos/${encodeURIComponent(job.id || '')}`;
    const response = await requestUrl({
      url,
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OpenRouter video polling failed: HTTP ${response.status}: ${response.text || 'Unknown error'}`);
    }

    return this.asJob(response.json);
  }

  private async downloadVideo(job: OpenRouterVideoJob): Promise<ArrayBuffer> {
    const unsignedUrl = job.unsigned_urls?.find(url => url.trim().length > 0);
    const url = unsignedUrl || job.output_url || job.url || `${this.baseUrl}/videos/${encodeURIComponent(job.id || '')}/content?index=0`;
    const shouldAuthorize = !unsignedUrl || url.startsWith(this.baseUrl) || url.startsWith('https://openrouter.ai/api/');
    const response = await requestUrl({
      url,
      method: 'GET',
      headers: shouldAuthorize ? this.getHeaders() : undefined,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OpenRouter video download failed: HTTP ${response.status}: ${response.text || 'Unknown error'}`);
    }

    return response.arrayBuffer;
  }

  private async fetchModelMetadata(): Promise<OpenRouterVideoModelMetadata[]> {
    const now = Date.now();
    if (this.modelCache && now - this.modelCacheTimestamp < this.cacheTtlMs) {
      return this.modelCache;
    }

    try {
      const response = await requestUrl({
        url: `${this.baseUrl}/videos/models`,
        method: 'GET',
        headers: this.getHeaders(),
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(response.text || `HTTP ${response.status}`);
      }

      const data = isRecord(response.json) && Array.isArray(response.json.data) ? response.json.data : [];
      this.modelCache = data
        .map(item => this.asModelMetadata(item))
        .filter((item): item is OpenRouterVideoModelMetadata => item !== null);
      this.modelCacheTimestamp = now;
      return this.modelCache;
    } catch {
      this.modelCache = getVideoModelsForProvider('openrouter').map(model => ({
        id: model.id,
        name: model.name,
        supported_resolutions: model.resolutions,
        supported_aspect_ratios: model.aspectRatios,
        supported_durations: model.durations,
        generate_audio: model.supportsAudioPrompting,
      }));
      this.modelCacheTimestamp = now;
      return this.modelCache;
    }
  }

  private getHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': this.httpReferer,
      'X-Title': this.xTitle,
    };
  }

  private asJob(value: unknown): OpenRouterVideoJob {
    if (!isRecord(value)) {
      throw new Error('OpenRouter video generation returned an invalid job response.');
    }

    const unsignedValue = value.unsigned_urls;
    return {
      id: getString(value.id),
      status: getString(value.status),
      polling_url: getString(value.polling_url),
      unsigned_urls: Array.isArray(unsignedValue) ? unsignedValue.filter((item): item is string => typeof item === 'string') : undefined,
      output_url: getString(value.output_url),
      url: getString(value.url),
      error: value.error,
    };
  }

  private asModelMetadata(value: unknown): OpenRouterVideoModelMetadata | null {
    if (!isRecord(value)) {
      return null;
    }

    const id = getString(value.id);
    if (!id) {
      return null;
    }

    return {
      id,
      name: getString(value.name),
      supported_resolutions: toStringArray(value.supported_resolutions),
      supported_aspect_ratios: toStringArray(value.supported_aspect_ratios),
      supported_durations: toNumberArray(value.supported_durations),
      generate_audio: value.generate_audio === true,
    };
  }

  private isTerminalStatus(status: string | undefined): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'canceled' || status === 'expired';
  }

  private formatJobError(error: unknown): string {
    if (!error) {
      return 'Unknown error';
    }
    if (typeof error === 'string') {
      return error;
    }
    if (isRecord(error)) {
      return getString(error.message) || JSON.stringify(error);
    }
    return 'Unknown error';
  }

  private asAspectRatios(values: string[] | undefined): VideoAspectRatio[] {
    const allowed: VideoAspectRatio[] = ['16:9', '9:16', '1:1'];
    return (values ?? []).filter((value): value is VideoAspectRatio => allowed.includes(value as VideoAspectRatio));
  }

  private asResolutions(values: string[] | undefined): VideoResolution[] {
    const allowed: VideoResolution[] = ['720p', '1080p', '4k'];
    return (values ?? [])
      .map(value => value === '4K' ? '4k' : value)
      .filter((value): value is VideoResolution => allowed.includes(value as VideoResolution));
  }
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function toNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map(getNumber).filter((item): item is number => item !== undefined);
}
