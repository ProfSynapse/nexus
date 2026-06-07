import { requestUrl, Vault } from 'obsidian';
import type {
  PendingVideoGenerationJob,
  ResolvedVideoGenerationRequest,
  VideoGenerationAdapter,
  VideoGenerationAdapterResult,
  VideoGenerationJobCheck,
} from '../VideoGenerationTypes';
import { VideoGenerationTimeoutError } from '../VideoGenerationTypes';
import type { VideoProvider } from '../../llm/types/VideoTypes';
import {
  getByPath,
  getString,
  isRecord,
  loadReferenceImage,
  sleep,
} from './videoAdapterUtils';

export interface GoogleVideoAdapterConfig {
  apiKey: string;
  vault: Vault;
}

interface GoogleOperation {
  name?: string;
  done?: boolean;
  error?: {
    message?: string;
    code?: number;
    status?: string;
  };
  response?: unknown;
}

export class GoogleVideoAdapter implements VideoGenerationAdapter {
  readonly provider: VideoProvider = 'google';
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta';

  constructor(private config: GoogleVideoAdapterConfig) {}

  isAvailable(): boolean {
    return this.config.apiKey.trim().length > 0;
  }

  async generate(request: ResolvedVideoGenerationRequest): Promise<VideoGenerationAdapterResult> {
    if (!this.isAvailable()) {
      throw new Error('Google video generation is not configured.');
    }

    const started = Date.now();
    let operation = await this.startOperation(request);
    if (!operation.name) {
      throw new Error('Google video generation did not return an operation name.');
    }
    const operationName = operation.name;

    while (!operation.done) {
      if (Date.now() - started > request.timeoutMs) {
        throw new VideoGenerationTimeoutError(
          `Google video generation timed out after ${Math.round(request.timeoutMs / 1000)} seconds. ` +
          `Operation name: ${operationName}.`,
          {
            provider: this.provider,
            model: request.model,
            providerJobId: operationName,
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
      operation = await this.pollOperation(operationName);
    }

    if (operation.error) {
      throw new Error(`Google video generation failed: ${operation.error.message || operation.error.status || operation.error.code || 'Unknown error'}`);
    }

    const video = await this.downloadCompletedVideo(operation);
    return {
      ...video,
      providerJobId: operationName,
      pollingUrl: `${this.baseUrl}/${operationName}`,
      durationSeconds: request.seconds,
    };
  }

  async checkJob(job: PendingVideoGenerationJob): Promise<VideoGenerationJobCheck> {
    if (!this.isAvailable()) {
      throw new Error('Google video generation is not configured.');
    }

    const operation = await this.pollOperation(job.providerJobId);
    const pollingUrl = `${this.baseUrl}/${job.providerJobId}`;

    if (!operation.done) {
      return {
        status: 'in_progress',
        providerJobId: job.providerJobId,
        pollingUrl,
      };
    }

    if (operation.error) {
      return {
        status: 'failed',
        providerJobId: job.providerJobId,
        pollingUrl,
        error: operation.error.message || operation.error.status || String(operation.error.code || 'Unknown error'),
      };
    }

    const video = await this.downloadCompletedVideo(operation);
    return {
      status: 'completed',
      result: {
        ...video,
        providerJobId: job.providerJobId,
        pollingUrl,
        durationSeconds: job.request?.seconds,
      },
    };
  }

  private async startOperation(request: ResolvedVideoGenerationRequest): Promise<GoogleOperation> {
    const instance: Record<string, unknown> = {
      prompt: request.prompt,
    };

    if (request.referenceImage) {
      const image = await loadReferenceImage(this.config.vault, request.referenceImage);
      instance.image = {
        bytesBase64Encoded: image.data,
        mimeType: image.mimeType,
      };
    }

    const parameters: Record<string, unknown> = {
      aspectRatio: request.aspectRatio,
      resolution: request.resolution,
    };

    if (request.seconds) {
      parameters.durationSeconds = request.seconds;
    }

    if (request.generateAudio !== undefined) {
      parameters.generateAudio = request.generateAudio;
    }

    if (request.negativePrompt) {
      parameters.negativePrompt = request.negativePrompt;
    }

    const response = await requestUrl({
      url: `${this.baseUrl}/models/${encodeURIComponent(request.model)}:predictLongRunning`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.config.apiKey,
      },
      body: JSON.stringify({
        instances: [instance],
        parameters,
      }),
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Google video generation failed: HTTP ${response.status}: ${response.text || 'Unknown error'}`);
    }

    return this.asOperation(response.json);
  }

  private async pollOperation(operationName: string): Promise<GoogleOperation> {
    const response = await requestUrl({
      url: `${this.baseUrl}/${operationName}`,
      method: 'GET',
      headers: {
        'x-goog-api-key': this.config.apiKey,
      },
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Google video polling failed: HTTP ${response.status}: ${response.text || 'Unknown error'}`);
    }

    return this.asOperation(response.json);
  }

  private async downloadCompletedVideo(operation: GoogleOperation): Promise<Omit<VideoGenerationAdapterResult, 'providerJobId' | 'durationSeconds'>> {
    const inlineData = this.findInlineVideoData(operation.response);
    if (inlineData) {
      return inlineData;
    }

    const uri = this.findVideoUri(operation.response);
    if (!uri) {
      throw new Error('Google video generation completed but no downloadable video was found.');
    }

    const response = await requestUrl({
      url: uri,
      method: 'GET',
      headers: {
        'x-goog-api-key': this.config.apiKey,
      },
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Google video download failed: HTTP ${response.status}: ${response.text || 'Unknown error'}`);
    }

    return {
      videoData: response.arrayBuffer,
      mimeType: 'video/mp4',
    };
  }

  private findVideoUri(response: unknown): string | undefined {
    const directPaths = [
      ['generatedVideos', '0', 'video', 'uri'],
      ['generatedVideos', '0', 'video', 'downloadUri'],
      ['generateVideoResponse', 'generatedSamples', '0', 'video', 'uri'],
      ['generateVideoResponse', 'generatedSamples', '0', 'video', 'downloadUri'],
      ['videos', '0', 'uri'],
      ['videos', '0', 'downloadUri'],
    ];

    for (const path of directPaths) {
      const value = getString(getByPathWithArrays(response, path));
      if (value) {
        return value;
      }
    }

    return this.findFirstStringKey(response, new Set(['uri', 'downloadUri', 'gcsUri']));
  }

  private findInlineVideoData(response: unknown): Omit<VideoGenerationAdapterResult, 'providerJobId' | 'durationSeconds'> | undefined {
    const dataPaths = [
      ['generatedVideos', '0', 'video', 'videoBytes'],
      ['generatedVideos', '0', 'video', 'bytesBase64Encoded'],
      ['generateVideoResponse', 'generatedSamples', '0', 'video', 'bytesBase64Encoded'],
    ];

    for (const path of dataPaths) {
      const data = getString(getByPathWithArrays(response, path));
      if (data) {
        return {
          videoData: base64ToArrayBuffer(data),
          mimeType: 'video/mp4',
        };
      }
    }

    return undefined;
  }

  private findFirstStringKey(value: unknown, keys: Set<string>): string | undefined {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.findFirstStringKey(item, keys);
        if (found) {
          return found;
        }
      }
      return undefined;
    }

    if (!isRecord(value)) {
      return undefined;
    }

    for (const [key, child] of Object.entries(value)) {
      if (keys.has(key) && typeof child === 'string') {
        return child;
      }
      const found = this.findFirstStringKey(child, keys);
      if (found) {
        return found;
      }
    }

    return undefined;
  }

  private asOperation(value: unknown): GoogleOperation {
    if (!isRecord(value)) {
      throw new Error('Google video generation returned an invalid operation response.');
    }

    const operation: GoogleOperation = {
      name: getString(value.name),
      done: value.done === true,
      response: value.response,
    };

    if (isRecord(value.error)) {
      operation.error = {
        message: getString(value.error.message),
        code: typeof value.error.code === 'number' ? value.error.code : undefined,
        status: getString(value.error.status),
      };
    }

    return operation;
  }
}

function getByPathWithArrays(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (Array.isArray(current)) {
      current = current[Number(key)];
      continue;
    }
    current = getByPath(current, [key]);
  }
  return current;
}

function base64ToArrayBuffer(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}
