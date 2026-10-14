import { requestUrl, Vault } from 'obsidian';
import type {
  PendingVideoGenerationJob,
  ResolvedVideoGenerationRequest,
  VideoGenerationAdapter,
  VideoGenerationAdapterResult,
  VideoGenerationJobCheck,
} from '../VideoGenerationTypes';
import { VideoGenerationTimeoutError } from '../VideoGenerationTypes';
import { getVideoModel, type VideoProvider } from '../../llm/types/VideoTypes';
import {
  getString,
  isRecord,
  loadReferenceImage,
  sleep,
  VideoGenerationAbortedError,
} from './videoAdapterUtils';

export interface GoogleVideoAdapterConfig {
  apiKey: string;
  vault: Vault;
}

/** One video found in a completed interaction: inline bytes, or a URI to fetch. */
interface InteractionVideo {
  data?: string;
  uri?: string;
}

interface GoogleInteraction {
  id?: string;
  status?: string;
  video?: InteractionVideo;
  /** Text the model returned alongside (or instead of) a video. */
  text?: string;
  errors: Array<{ code?: string; message?: string }>;
}

type InteractionState = 'pending' | 'completed' | 'failed';

interface VideoReadOptions {
  /** Look once: report a still-processing output file as 'pending'. */
  singleCheck?: boolean;
  signal?: AbortSignal;
  /** Epoch ms after which waiting for the output file times out. */
  deadline?: number;
  pollIntervalMs?: number;
  onTimeout?: () => Error;
}

const GOOGLE_API_HOST = 'generativelanguage.googleapis.com';
const GOOGLE_API_BASE = `https://${GOOGLE_API_HOST}/v1beta`;

/**
 * Hosts that legitimately serve a Google video/file download URL which REQUIRES
 * the user's API key (`x-goog-api-key`). The Gemini Files API returns download
 * URIs on `generativelanguage.googleapis.com` that must be fetched with the
 * key. Any other host (e.g. a pre-signed `storage.googleapis.com` URL) does NOT
 * need the key, so the credential is dropped there — this both blocks
 * credential exfiltration to an attacker-controlled host scraped from the
 * response body (SEC-M1) and remains safe for legitimate pre-signed downloads.
 */
const GOOGLE_CREDENTIALED_DOWNLOAD_HOSTS = new Set<string>([GOOGLE_API_HOST]);

/** Interaction states that mean "keep polling". */
const PENDING_STATUSES = new Set(['in_progress', 'queued']);
/** Interaction states that end the job without a usable video. */
const FAILED_STATUSES = new Set(['failed', 'cancelled', 'incomplete', 'requires_action']);

/**
 * Operation names left behind by the retired Veo 3.1 preview path
 * (`models/<id>/operations/<op>`). Interaction ids never contain a slash.
 */
function isLegacyVeoOperation(jobId: string): boolean {
  return jobId.includes('/operations/') || jobId.startsWith('operations/');
}

/**
 * Google-direct video generation with Gemini Omni Flash over the Interactions
 * API (https://ai.google.dev/gemini-api/docs/omni).
 *
 * Flow: `POST /v1beta/interactions` with `background: true`, poll
 * `GET /v1beta/interactions/{id}` until the status is terminal, then take the
 * MP4 from the `model_output` step — inline base64 (`data`), or a Files API URI
 * that is polled until ACTIVE and downloaded with the API key. A caller abort
 * stops polling and asks Google to cancel the interaction; a timeout surfaces
 * the interaction id so `checkJob` can finish the job later.
 */
export class GoogleVideoAdapter implements VideoGenerationAdapter {
  readonly provider: VideoProvider = 'google';
  private readonly baseUrl = GOOGLE_API_BASE;

  constructor(private config: GoogleVideoAdapterConfig) {}

  isAvailable(): boolean {
    return this.config.apiKey.trim().length > 0;
  }

  async generate(request: ResolvedVideoGenerationRequest): Promise<VideoGenerationAdapterResult> {
    if (!this.isAvailable()) {
      throw new Error('Google video generation is not configured.');
    }
    this.assertSupportedOptions(request);
    if (request.signal?.aborted) {
      throw new VideoGenerationAbortedError();
    }

    const started = Date.now();
    const deadline = started + request.timeoutMs;
    let interaction = await this.createInteraction(request);
    const interactionId = interaction.id;

    try {
      while (this.classify(interaction) === 'pending') {
        if (!interactionId) {
          throw new Error('Google video generation did not return an interaction id to poll.');
        }
        if (Date.now() >= deadline) {
          throw this.timeoutError(request, interactionId);
        }
        await sleep(Math.min(request.pollIntervalMs, Math.max(0, deadline - Date.now())), request.signal);
        interaction = await this.getInteraction(interactionId);
        if (request.signal?.aborted) {
          throw new VideoGenerationAbortedError();
        }
      }

      if (this.classify(interaction) === 'failed') {
        throw new Error(this.describeInteractionFailure(interaction, request.model));
      }

      const videoData = await this.readCompletedVideo(interaction, request.model, {
        signal: request.signal,
        deadline,
        pollIntervalMs: request.pollIntervalMs,
        onTimeout: () => this.timeoutError(request, interactionId),
      });
      if (videoData === 'pending') {
        // Unreachable without singleCheck; kept so the type is honest.
        throw this.timeoutError(request, interactionId);
      }

      return {
        videoData,
        mimeType: 'video/mp4',
        providerJobId: interactionId,
        pollingUrl: interactionId ? this.interactionUrl(interactionId) : undefined,
        durationSeconds: request.seconds,
      };
    } catch (error) {
      if (error instanceof VideoGenerationAbortedError && interactionId) {
        await this.cancelInteraction(interactionId);
      }
      throw error;
    }
  }

  async checkJob(job: PendingVideoGenerationJob): Promise<VideoGenerationJobCheck> {
    if (!this.isAvailable()) {
      throw new Error('Google video generation is not configured.');
    }

    if (isLegacyVeoOperation(job.providerJobId)) {
      return {
        status: 'failed',
        providerJobId: job.providerJobId,
        pollingUrl: job.pollingUrl,
        error: 'This job was started on a Veo 3.1 preview model, which Google shuts down on 2026-10-22, and Nexus no longer polls those jobs. Generate the video again; Google video now uses gemini-omni-1.1-flash.',
      };
    }

    const pollingUrl = this.interactionUrl(job.providerJobId);
    const interaction = await this.getInteraction(job.providerJobId);
    const state = this.classify(interaction);

    if (state === 'pending') {
      return { status: 'in_progress', providerJobId: job.providerJobId, pollingUrl };
    }

    if (state === 'failed') {
      return {
        status: 'failed',
        providerJobId: job.providerJobId,
        pollingUrl,
        error: this.describeInteractionFailure(interaction, job.model),
      };
    }

    // A check is a single look: a Files API URI that is not ACTIVE yet reports
    // in_progress instead of waiting here.
    let videoData: ArrayBuffer | 'pending';
    try {
      videoData = await this.readCompletedVideo(interaction, job.model, { singleCheck: true });
    } catch (error) {
      return {
        status: 'failed',
        providerJobId: job.providerJobId,
        pollingUrl,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (videoData === 'pending') {
      return { status: 'in_progress', providerJobId: job.providerJobId, pollingUrl };
    }

    return {
      status: 'completed',
      result: {
        videoData,
        mimeType: 'video/mp4',
        providerJobId: job.providerJobId,
        pollingUrl,
        durationSeconds: job.request?.seconds,
      },
    };
  }

  /**
   * Reject options the model has no parameter for, before anything is billed.
   * Negative prompts are folded into the prompt instead (see buildPrompt), as
   * Google's limitations section recommends.
   */
  private assertSupportedOptions(request: ResolvedVideoGenerationRequest): void {
    const declaration = getVideoModel('google', request.model);
    if (request.generateAudio === false) {
      throw new Error(
        `Google video model "${request.model}" always generates audio and has no option to turn it off. ` +
        'Omit generateAudio, or describe a silent scene in the prompt.'
      );
    }
    if (request.seconds !== undefined) {
      const durations = declaration?.durations;
      if (!Number.isInteger(request.seconds) || (durations && !durations.includes(request.seconds))) {
        const range = durations?.length ? `${durations[0]}-${durations[durations.length - 1]}` : 'a whole number of';
        throw new Error(
          `Google video model "${request.model}" does not support a ${request.seconds}-second clip. ` +
          `Use ${range} seconds, or omit seconds to let the model choose.`
        );
      }
    }
  }

  private async createInteraction(request: ResolvedVideoGenerationRequest): Promise<GoogleInteraction> {
    const responseFormat: Record<string, unknown> = {
      type: 'video',
      aspect_ratio: request.aspectRatio,
      resolution: request.resolution,
    };
    if (request.seconds !== undefined) {
      // google-duration format in the Interactions OpenAPI spec: "<n>s".
      responseFormat.duration = `${request.seconds}s`;
    }

    const body: Record<string, unknown> = {
      model: request.model,
      input: await this.buildInput(request),
      response_format: responseFormat,
      background: true,
    };

    let response = await this.post(`${this.baseUrl}/interactions`, body);
    if (response.status === 400 && /background/i.test(response.text || '')) {
      // Background execution is documented for Gemini models generally, not
      // for Omni specifically. If Google rejects it for this model, fall back
      // to the synchronous call the Omni guide documents; it returns the
      // completed interaction, which the caller handles the same way.
      delete body.background;
      response = await this.post(`${this.baseUrl}/interactions`, body);
    }

    if (response.status < 200 || response.status >= 300) {
      throw new Error(describeGoogleVideoHttpError(response.status, response.text, request.model, 'generation'));
    }

    return this.asInteraction(response.json);
  }

  private async buildInput(request: ResolvedVideoGenerationRequest): Promise<string | Array<Record<string, unknown>>> {
    const text = this.buildPrompt(request);
    if (!request.referenceImage) {
      return text;
    }

    const image = await loadReferenceImage(this.config.vault, request.referenceImage);
    return [
      { type: 'image', data: image.data, mime_type: image.mimeType },
      { type: 'text', text },
    ];
  }

  private buildPrompt(request: ResolvedVideoGenerationRequest): string {
    const negative = request.negativePrompt?.trim();
    return negative ? `${request.prompt}\n\nDo not include: ${negative}` : request.prompt;
  }

  private async post(url: string, body: Record<string, unknown>) {
    return requestUrl({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.config.apiKey,
      },
      body: JSON.stringify(body),
      throw: false,
    });
  }

  private async getInteraction(interactionId: string): Promise<GoogleInteraction> {
    const response = await requestUrl({
      url: this.interactionUrl(interactionId),
      method: 'GET',
      headers: { 'x-goog-api-key': this.config.apiKey },
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(describeGoogleVideoHttpError(response.status, response.text, undefined, 'polling'));
    }

    return this.asInteraction(response.json);
  }

  /** Best effort: a cancel that fails must not mask the abort that caused it. */
  private async cancelInteraction(interactionId: string): Promise<void> {
    try {
      await requestUrl({
        url: `${this.interactionUrl(interactionId)}/cancel`,
        method: 'POST',
        headers: { 'x-goog-api-key': this.config.apiKey },
        throw: false,
      });
    } catch {
      // The interaction is billed or not regardless; nothing to recover here.
    }
  }

  private interactionUrl(interactionId: string): string {
    return `${this.baseUrl}/interactions/${encodeURIComponent(interactionId)}`;
  }

  private classify(interaction: GoogleInteraction): InteractionState {
    const status = interaction.status;
    if (status === 'completed') return 'completed';
    if (status && FAILED_STATUSES.has(status)) return 'failed';
    if (status && PENDING_STATUSES.has(status)) return 'pending';
    // No (or an unknown) status: decide from what the body carries.
    if (interaction.video) return 'completed';
    if (interaction.errors.length > 0) return 'failed';
    return 'pending';
  }

  /**
   * The MP4 bytes of a completed interaction. With `singleCheck`, a Files API
   * URI that is still processing returns 'pending' instead of being waited on;
   * without it the result is always bytes (or a thrown error).
   */
  private async readCompletedVideo(
    interaction: GoogleInteraction,
    model: string | undefined,
    options: VideoReadOptions
  ): Promise<ArrayBuffer | 'pending'> {
    const video = interaction.video;
    if (video?.data) {
      return base64ToArrayBuffer(video.data);
    }
    if (video?.uri) {
      return this.downloadVideoUri(video.uri, options);
    }

    const said = interaction.text ? ` The model said: "${truncate(interaction.text, 300)}"` : '';
    throw new Error(
      `Google video generation completed but returned no video${model ? ` for "${model}"` : ''}. ` +
      `This usually means the prompt or the generated video was blocked by Google's safety filters.${said}`
    );
  }

  /**
   * Fetch a video the interaction returned by URI. A Files API resource on the
   * Gemini host is polled until ACTIVE (FAILED ends the job), then downloaded
   * with the API key; any other host is fetched without the key (SEC-M1).
   */
  private async downloadVideoUri(uri: string, options: VideoReadOptions): Promise<ArrayBuffer | 'pending'> {
    const file = this.resolveFilesResource(uri);
    if (!file) {
      return this.download(uri, this.shouldAttachApiKey(uri));
    }

    for (;;) {
      const state = await this.getFileState(file.name);
      if (state === 'FAILED') {
        throw new Error('Google finished the video, but processing the output file failed. Generate it again.');
      }
      if (state === 'ACTIVE' || state === undefined) {
        return this.download(file.downloadUrl, true);
      }
      if (options.singleCheck) {
        return 'pending';
      }
      if (options.deadline !== undefined && Date.now() >= options.deadline) {
        throw options.onTimeout ? options.onTimeout() : new Error('Google video file was not ready before the timeout.');
      }
      const wait = options.pollIntervalMs ?? 5_000;
      await sleep(
        options.deadline !== undefined ? Math.min(wait, Math.max(0, options.deadline - Date.now())) : wait,
        options.signal
      );
    }
  }

  /**
   * `files/<id>` (relative) or `https://generativelanguage.googleapis.com/v1beta/files/<id>...`
   * → the resource name and its download URL. Undefined for any other URI.
   */
  private resolveFilesResource(uri: string): { name: string; downloadUrl: string } | undefined {
    const relative = /^files\/([A-Za-z0-9_-]+)/.exec(uri);
    if (relative) {
      const name = `files/${relative[1]}`;
      return { name, downloadUrl: `${this.baseUrl}/${name}:download?alt=media` };
    }

    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return undefined;
    }
    if (parsed.protocol !== 'https:' || !GOOGLE_CREDENTIALED_DOWNLOAD_HOSTS.has(parsed.hostname)) {
      return undefined;
    }
    const match = /^\/v1beta\/files\/([A-Za-z0-9_-]+)/.exec(parsed.pathname);
    if (!match) {
      return undefined;
    }
    const name = `files/${match[1]}`;
    const downloadUrl = parsed.pathname.includes(':download')
      ? parsed.toString()
      : `${this.baseUrl}/${name}:download?alt=media`;
    return { name, downloadUrl };
  }

  private async getFileState(name: string): Promise<string | undefined> {
    const response = await requestUrl({
      url: `${this.baseUrl}/${name}`,
      method: 'GET',
      headers: { 'x-goog-api-key': this.config.apiKey },
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(describeGoogleVideoHttpError(response.status, response.text, undefined, 'download'));
    }
    const json: unknown = response.json;
    return isRecord(json) ? getString(json.state) : undefined;
  }

  private async download(url: string, attachApiKey: boolean): Promise<ArrayBuffer> {
    const response = await requestUrl({
      url,
      method: 'GET',
      headers: attachApiKey ? { 'x-goog-api-key': this.config.apiKey } : undefined,
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(describeGoogleVideoHttpError(response.status, safeText(response), undefined, 'download'));
    }

    return response.arrayBuffer;
  }

  /**
   * Whether the user's API key should be attached when downloading from `url`.
   * Returns true only when the resolved host is on the Google credentialed-host
   * allowlist; an unparseable URL is treated as off-allowlist (no credential).
   */
  private shouldAttachApiKey(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && GOOGLE_CREDENTIALED_DOWNLOAD_HOSTS.has(parsed.hostname);
    } catch {
      return false;
    }
  }

  private timeoutError(request: ResolvedVideoGenerationRequest, interactionId: string | undefined): VideoGenerationTimeoutError {
    return new VideoGenerationTimeoutError(
      `Google video generation timed out after ${Math.round(request.timeoutMs / 1000)} seconds. ` +
      `Interaction id: ${interactionId ?? 'unknown'}.`,
      {
        provider: this.provider,
        model: request.model,
        providerJobId: interactionId,
        pollingUrl: interactionId ? this.interactionUrl(interactionId) : undefined,
        timeoutMs: request.timeoutMs,
        request: {
          seconds: request.seconds,
          aspectRatio: request.aspectRatio,
          resolution: request.resolution,
        },
      }
    );
  }

  private describeInteractionFailure(interaction: GoogleInteraction, model: string | undefined): string {
    const detail = interaction.errors
      .map(error => [error.code, error.message].filter(Boolean).join(': '))
      .filter(Boolean)
      .join('; ');
    const codes = interaction.errors.map(error => `${error.code ?? ''} ${error.message ?? ''}`).join(' ');

    if (isSafetyBlock(codes)) {
      return safetyMessage(detail || interaction.text);
    }
    if (isQuotaError(codes)) {
      return quotaMessage(detail);
    }

    const label = model ? ` for "${model}"` : '';
    switch (interaction.status) {
      case 'cancelled':
        return `Google video generation${label} was cancelled.${detail ? ` ${detail}` : ''}`;
      case 'incomplete':
        return `Google video generation${label} ended incomplete and returned no usable video.${detail ? ` ${detail}` : ''}`;
      case 'requires_action':
        return `Google video generation${label} stopped to ask for input, which Nexus does not support for video.`;
      default:
        return `Google video generation${label} failed: ${detail || 'Google reported a failure without details.'}`;
    }
  }

  private asInteraction(value: unknown): GoogleInteraction {
    if (!isRecord(value)) {
      throw new Error('Google video generation returned an invalid interaction response.');
    }

    const errors = Array.isArray(value.errors)
      ? value.errors.filter(isRecord).map(error => ({
        code: typeof error.code === 'string' ? error.code : undefined,
        message: getString(error.message),
      }))
      : [];

    return {
      id: getString(value.id),
      status: getString(value.status),
      video: findInteractionVideo(value),
      text: findInteractionText(value),
      errors,
    };
  }
}

/**
 * The video in an interaction body. REST puts it in the `model_output` step's
 * content (https://ai.google.dev/gemini-api/docs/omni#rest-response-schema);
 * the guide's URI-delivery shell sample also reads a top-level `output_video`,
 * so that is accepted too. The last video wins.
 */
function findInteractionVideo(body: Record<string, unknown>): InteractionVideo | undefined {
  let found: InteractionVideo | undefined;
  const steps = Array.isArray(body.steps) ? body.steps : [];
  for (const step of steps) {
    if (!isRecord(step) || step.type !== 'model_output' || !Array.isArray(step.content)) continue;
    for (const item of step.content) {
      const video = asVideoContent(item);
      if (video) found = video;
    }
  }
  return found ?? asVideoContent(body.output_video, true);
}

function asVideoContent(item: unknown, untyped = false): InteractionVideo | undefined {
  if (!isRecord(item) || (!untyped && item.type !== 'video')) return undefined;
  const data = getString(item.data);
  const uri = getString(item.uri);
  return data || uri ? { data, uri } : undefined;
}

function findInteractionText(body: Record<string, unknown>): string | undefined {
  const steps = Array.isArray(body.steps) ? body.steps : [];
  const texts: string[] = [];
  for (const step of steps) {
    if (!isRecord(step) || step.type !== 'model_output' || !Array.isArray(step.content)) continue;
    for (const item of step.content) {
      if (isRecord(item) && item.type === 'text') {
        const text = getString(item.text);
        if (text) texts.push(text);
      }
    }
  }
  return texts.length ? texts.join(' ') : undefined;
}

function isSafetyBlock(text: string): boolean {
  return /content_blocked|blocked|safety|prohibited|responsible ai|usage polic/i.test(text);
}

function isQuotaError(text: string): boolean {
  return /resource_exhausted|quota|rate limit|rate_limit/i.test(text);
}

function safetyMessage(detail: string | undefined): string {
  return (
    'Google blocked this video request under its safety or usage policies' +
    (detail ? ` (${truncate(detail, 300)})` : '') +
    '. Rephrase the prompt, or use a different reference image. Images of minors and of some recognisable people are not accepted.'
  );
}

function quotaMessage(detail: string | undefined): string {
  return (
    'Google video generation hit a quota or rate limit' +
    (detail ? ` (${truncate(detail, 300)})` : '') +
    '. Wait and try again, or check the Gemini API plan: Gemini Omni Flash is available on the paid tier only.'
  );
}

/**
 * A readable message for a non-2xx Gemini API response. Google error bodies
 * are `{ error: { code, message, status } }`; the Interactions API uses string
 * codes such as `content_blocked`.
 */
export function describeGoogleVideoHttpError(
  httpStatus: number,
  text: string | undefined,
  model: string | undefined,
  phase: 'generation' | 'polling' | 'download'
): string {
  // Parse the text rather than reading `response.json`: Obsidian's json getter
  // throws on a body that is not JSON, which would replace this message.
  let parsed: unknown;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : isRecord(parsed) ? parsed : {};
  const message = getString(error.message) ?? (text ? truncate(text, 300) : undefined);
  const code = typeof error.code === 'string' || typeof error.code === 'number' ? String(error.code) : '';
  const status = getString(error.status) ?? '';
  const signals = `${code} ${status} ${message ?? ''}`;
  const detail = message ? `: ${truncate(message, 300)}` : '';
  const label = model ? ` "${model}"` : '';

  if (isSafetyBlock(`${code} ${status}`) || (httpStatus === 400 && isSafetyBlock(signals))) {
    return safetyMessage(message);
  }
  if (httpStatus === 429 || isQuotaError(`${code} ${status}`)) {
    return quotaMessage(message);
  }
  if (httpStatus === 401 || httpStatus === 403 || /UNAUTHENTICATED|PERMISSION_DENIED/.test(status)) {
    return `Google rejected the API key for video ${phase} (HTTP ${httpStatus})${detail}. Check the key, and that its project is on the paid tier with access to Gemini Omni Flash.`;
  }
  if (httpStatus === 404) {
    return phase === 'generation'
      ? `Google does not recognise the video model${label} (HTTP 404)${detail}.`
      : `Google no longer has this video job (HTTP 404)${detail}. Interactions are kept for a limited time; generate the video again.`;
  }
  if (httpStatus === 400) {
    return `Google rejected an option in the video request (HTTP 400)${detail}. Gemini Omni Flash accepts aspect ratio 16:9 or 9:16, resolution 360p, 720p, 1080p or 4k, 3-10 seconds, and JPEG, PNG or WebP reference images.`;
  }
  return `Google video ${phase} failed (HTTP ${httpStatus})${detail}`;
}

/** A download error body may be binary; reading it must not throw. */
function safeText(response: { text: string }): string | undefined {
  try {
    return response.text;
  } catch {
    return undefined;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function base64ToArrayBuffer(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}
