import { App, normalizePath, TFolder, Vault } from 'obsidian';
import type { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import { isValidPath } from '../../utils/pathUtils';
import {
  buildVideoProviderAvailability,
  resolveDefaultVideoSelection,
  type VideoAspectRatio,
  type VideoModelDeclaration,
  type VideoProvider,
  type VideoResolution,
} from '../llm/types/VideoTypes';
import { GoogleVideoAdapter } from './adapters/GoogleVideoAdapter';
import { OpenRouterVideoAdapter } from './adapters/OpenRouterVideoAdapter';
import { sleep } from './adapters/videoAdapterUtils';
import type {
  GenerateVideoRequest,
  GenerateVideoResult,
  PendingVideoGenerationJob,
  ResolvedVideoGenerationRequest,
  VideoGenerationAdapter,
  VideoGenerationAdapterResult,
  VideoGenerationCheckOptions,
  VideoGenerationFinalizeResult,
} from './VideoGenerationTypes';
import { VideoGenerationTimeoutError } from './VideoGenerationTypes';

export interface VideoGenerationServiceOptions {
  llmSettings: LLMProviderSettings | null;
}

export class VideoGenerationService {
  private adapters = new Map<VideoProvider, VideoGenerationAdapter>();

  constructor(
    private app: App,
    private vault: Vault,
    private options: VideoGenerationServiceOptions
  ) {
    this.initializeAdapters();
  }

  async generate(request: GenerateVideoRequest): Promise<GenerateVideoResult> {
    const resolved = this.resolveRequest(request);
    const adapter = this.adapters.get(resolved.provider);

    if (!adapter || !adapter.isAvailable()) {
      throw new Error(`Video provider "${resolved.provider}" is not configured or not enabled.`);
    }

    const outputPath = this.normalizeOutputPath(request.outputPath);
    this.validateOutputExtension(outputPath);

    let result: VideoGenerationAdapterResult;
    try {
      result = await adapter.generate(resolved);
    } catch (error) {
      if (error instanceof VideoGenerationTimeoutError) {
        throw error.withOutputPath(outputPath);
      }
      throw error;
    }

    await this.writeVideo(outputPath, result.videoData, request.overwrite === true);

    return {
      status: 'completed',
      path: outputPath,
      provider: resolved.provider,
      model: resolved.model,
      mimeType: result.mimeType,
      promptLength: request.prompt.length,
      videoSize: result.videoData.byteLength,
      durationSeconds: result.durationSeconds,
      aspectRatio: resolved.aspectRatio,
      resolution: resolved.resolution,
      providerJobId: result.providerJobId,
      pollingUrl: result.pollingUrl,
      note: `Video generation completed and saved to ${outputPath}.`,
    };
  }

  async finalizePendingJob(
    job: PendingVideoGenerationJob,
    options: VideoGenerationCheckOptions = {}
  ): Promise<VideoGenerationFinalizeResult> {
    const adapter = this.adapters.get(job.provider);
    if (!adapter || !adapter.isAvailable()) {
      throw new Error(`Video provider "${job.provider}" is not configured or not enabled.`);
    }

    const outputPath = this.normalizeOutputPath(job.outputPath);
    this.validateOutputExtension(outputPath);

    const started = Date.now();
    const timeoutMs = options.timeoutMs ?? 30_000;
    const pollIntervalMs = options.pollIntervalMs ?? 5_000;
    let latestProviderJobId = job.providerJobId;
    let latestPollingUrl = job.pollingUrl;

    while (Date.now() - started <= timeoutMs) {
      const check = await adapter.checkJob({
        ...job,
        outputPath,
        providerJobId: latestProviderJobId,
        pollingUrl: latestPollingUrl,
      });

      if (check.status === 'completed') {
        await this.writeVideo(outputPath, check.result.videoData, job.overwrite === true);
        return {
          status: 'completed',
          path: outputPath,
          provider: job.provider,
          model: job.model || '',
          mimeType: check.result.mimeType,
          promptLength: 0,
          videoSize: check.result.videoData.byteLength,
          durationSeconds: check.result.durationSeconds,
          aspectRatio: job.request?.aspectRatio || '16:9',
          resolution: job.request?.resolution || '720p',
          providerJobId: check.result.providerJobId || latestProviderJobId,
          pollingUrl: check.result.pollingUrl || latestPollingUrl,
          note: `Video generation completed and saved to ${outputPath}.`,
        };
      }

      if (check.status === 'failed') {
        return {
          status: 'failed',
          path: outputPath,
          provider: job.provider,
          model: job.model,
          providerJobId: check.providerJobId || latestProviderJobId,
          pollingUrl: check.pollingUrl || latestPollingUrl,
          error: check.error,
          note: `Video generation failed before it could be saved to ${outputPath}.`,
        };
      }

      latestProviderJobId = check.providerJobId || latestProviderJobId;
      latestPollingUrl = check.pollingUrl || latestPollingUrl;

      if (Date.now() - started + pollIntervalMs > timeoutMs) {
        break;
      }
      await sleep(pollIntervalMs);
    }

    return {
      status: 'in_progress',
      path: outputPath,
      provider: job.provider,
      model: job.model,
      providerJobId: latestProviderJobId,
      pollingUrl: latestPollingUrl,
      note: `Video generation is still running. The requested output path is ${outputPath}; check this job again later to save the completed media there.`,
    };
  }

  hasAvailableProviders(): boolean {
    return this.adapters.size > 0;
  }

  getInitializedProviders(): VideoProvider[] {
    return Array.from(this.adapters.keys());
  }

  getSupportedModelIds(provider: VideoProvider): string[] {
    return buildVideoProviderAvailability(this.options.llmSettings)
      .find(item => item.provider === provider)
      ?.models.map(model => model.id) ?? [];
  }

  async getModelsForProvider(provider: VideoProvider): Promise<VideoModelDeclaration[]> {
    const adapter = this.adapters.get(provider);
    if (provider === 'openrouter' && adapter instanceof OpenRouterVideoAdapter) {
      return adapter.listModels();
    }

    return buildVideoProviderAvailability(this.options.llmSettings)
      .find(item => item.provider === provider)
      ?.models ?? [];
  }

  resolveRequest(request: GenerateVideoRequest): ResolvedVideoGenerationRequest {
    if (!request.prompt.trim()) {
      throw new Error('Prompt is required.');
    }

    const availability = buildVideoProviderAvailability(this.options.llmSettings);
    const selection = resolveDefaultVideoSelection(
      this.options.llmSettings,
      request.provider,
      request.model,
      availability
    );

    if (selection.status !== 'resolved' || !selection.provider || !selection.model || !selection.modelDeclaration) {
      throw new Error(selection.reason ?? 'No video provider/model available. Configure a video provider in default settings.');
    }

    const model = selection.modelDeclaration;
    const aspectRatio = this.resolveAspectRatio(request.aspectRatio, model);
    const resolution = this.resolveResolution(request.resolution, model);

    if (request.seconds !== undefined && request.seconds <= 0) {
      throw new Error('seconds must be greater than 0.');
    }

    if (request.referenceImage && !model.supportsReferenceImage) {
      throw new Error(`Video model "${model.id}" does not support reference images.`);
    }

    return {
      prompt: request.prompt,
      provider: selection.provider,
      model: selection.model,
      aspectRatio,
      resolution,
      seconds: request.seconds,
      referenceImage: request.referenceImage,
      generateAudio: request.generateAudio,
      negativePrompt: request.negativePrompt,
      pollIntervalMs: request.pollIntervalMs ?? 10_000,
      timeoutMs: request.timeoutMs ?? 10 * 60_000,
    };
  }

  private initializeAdapters(): void {
    const googleConfig = this.options.llmSettings?.providers?.google;
    if (googleConfig?.enabled && googleConfig.apiKey?.trim()) {
      this.adapters.set('google', new GoogleVideoAdapter({
        apiKey: googleConfig.apiKey,
        vault: this.vault,
      }));
    }

    const openRouterConfig = this.options.llmSettings?.providers?.openrouter;
    if (openRouterConfig?.enabled && openRouterConfig.apiKey?.trim()) {
      this.adapters.set('openrouter', new OpenRouterVideoAdapter({
        apiKey: openRouterConfig.apiKey,
        vault: this.vault,
        httpReferer: openRouterConfig.httpReferer,
        xTitle: openRouterConfig.xTitle,
      }));
    }
  }

  private resolveAspectRatio(
    requested: VideoAspectRatio | undefined,
    model: VideoModelDeclaration
  ): VideoAspectRatio {
    const value = requested || this.options.llmSettings?.defaultVideoModel?.aspectRatio || model.defaultAspectRatio;
    if (!model.aspectRatios.includes(value)) {
      throw new Error(`Video model "${model.id}" does not support aspect ratio "${value}". Supported: ${model.aspectRatios.join(', ')}.`);
    }
    return value;
  }

  private resolveResolution(
    requested: VideoResolution | undefined,
    model: VideoModelDeclaration
  ): VideoResolution {
    const value = requested || this.options.llmSettings?.defaultVideoModel?.resolution || model.defaultResolution;
    if (!model.resolutions.includes(value)) {
      throw new Error(`Video model "${model.id}" does not support resolution "${value}". Supported: ${model.resolutions.join(', ')}.`);
    }
    return value;
  }

  private normalizeOutputPath(outputPath: string): string {
    if (!outputPath.trim()) {
      throw new Error('outputPath is required.');
    }

    if (!isValidPath(outputPath)) {
      throw new Error(`Invalid outputPath "${outputPath}". Use a vault-relative path with no ".." or absolute path segments.`);
    }

    return normalizePath(outputPath);
  }

  private validateOutputExtension(outputPath: string): void {
    if (!outputPath.toLowerCase().endsWith('.mp4')) {
      throw new Error('outputPath must end with .mp4.');
    }
  }

  private async writeVideo(outputPath: string, videoData: ArrayBuffer, overwrite: boolean): Promise<void> {
    const existingFile = this.vault.getAbstractFileByPath(outputPath);
    if (existingFile && !overwrite) {
      throw new Error(`File already exists at ${outputPath}. Set overwrite: true to replace.`);
    }

    await this.ensureParentDirectory(outputPath);

    if (!existingFile) {
      await this.vault.createBinary(outputPath, videoData);
      return;
    }

    const tempPath = `${outputPath}.generating`;
    await this.vault.createBinary(tempPath, videoData);
    await this.app.fileManager.trashFile(existingFile);
    const tempFile = this.vault.getAbstractFileByPath(tempPath);
    if (!tempFile) {
      throw new Error(`Failed to find generated temporary file: ${tempPath}`);
    }
    await this.vault.rename(tempFile, outputPath);
  }

  private async ensureParentDirectory(outputPath: string): Promise<void> {
    const dir = outputPath.substring(0, outputPath.lastIndexOf('/'));
    if (!dir || this.vault.getAbstractFileByPath(dir) instanceof TFolder) {
      return;
    }

    try {
      await this.vault.createFolder(dir);
    } catch {
      if (!(this.vault.getAbstractFileByPath(dir) instanceof TFolder)) {
        throw new Error(`Failed to create output directory: ${dir}`);
      }
    }
  }
}
