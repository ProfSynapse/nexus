import { App, normalizePath, TFolder, Vault } from 'obsidian';
import type { AppsSettings } from '../../types/apps/AppTypes';
import type { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import { tryResolveVaultPath } from '../../core/vaultPath';
import { SpeechSynthesisService } from '../readAloud/SpeechSynthesisService';
import type { SpeechSynthesisRequest } from '../readAloud/SpeechSynthesisTypes';
import { getSpeechOutputExtension, type SpeechProvider } from '../llm/types/SpeechTypes';
import {
  listConfiguredGeneratedAudioModels,
  type AudioType,
  type GeneratedAudioModelDeclaration,
  type GeneratedAudioType,
} from '../llm/types/GeneratedAudioTypes';
import { generateAudioWithProvider } from './GeneratedAudioAdapters';

/** The earlier name for `type`. Saved calls may still send `mode: 'voice'`. */
export type AudioGenerationMode = 'voice';

/**
 * Maps a synthesized-audio mimeType to its canonical file extension (no dot).
 * Single source of truth for both the upfront allowed-extension check and the
 * post-synthesis mimeType↔extension consistency check, so the two never drift.
 * Speech adapters currently emit only audio/mpeg (OpenAI/OpenRouter/Mistral/
 * ElevenLabs, all response_format mp3) and audio/wav (Google).
 */
const AUDIO_MIME_TO_EXTENSION: Readonly<Record<string, string>> = {
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

const ALLOWED_AUDIO_EXTENSIONS: readonly string[] = Object.values(AUDIO_MIME_TO_EXTENSION);

export interface GenerateAudioRequest {
  type?: AudioType;
  mode?: AudioGenerationMode;
  prompt: string;
  provider?: string;
  model?: string;
  voice?: string;
  durationSeconds?: number;
  instrumental?: boolean;
  loop?: boolean;
  outputPath: string;
  overwrite?: boolean;
}

export interface GenerateAudioResult {
  path: string;
  type: AudioType;
  provider: string;
  model: string;
  voice?: string;
  mimeType: string;
  textLength: number;
  audioSize: number;
  /** Lyrics and structure, when a music model writes them. */
  lyrics?: string;
  /** Set when a request had no effect on this model, or the model decided for itself. */
  note?: string;
}

export interface AudioGenerationServiceOptions {
  llmSettings: LLMProviderSettings | null;
  appsSettings?: AppsSettings;
}

export class AudioGenerationService {
  private speechService: SpeechSynthesisService;
  private readonly options: AudioGenerationServiceOptions;

  constructor(
    private app: App,
    private vault: Vault,
    options: AudioGenerationServiceOptions
  ) {
    this.options = options;
    this.speechService = new SpeechSynthesisService(options.llmSettings, {
      appsSettings: options.appsSettings,
    });
  }

  async generate(request: GenerateAudioRequest): Promise<GenerateAudioResult> {
    const type = this.resolveType(request);

    if (!request.prompt.trim()) {
      throw new Error('Prompt is required.');
    }

    const outputPath = this.normalizeOutputPath(request.outputPath);
    this.validateOutputExtension(outputPath);

    if (type !== 'speech') {
      return this.generateMusicOrEffect(type, request, outputPath);
    }

    const ignored = [
      ...(request.durationSeconds !== undefined ? ['durationSeconds'] : []),
      ...(request.instrumental !== undefined ? ['instrumental'] : []),
      ...(request.loop !== undefined ? ['loop'] : []),
    ];
    const speechRequest: SpeechSynthesisRequest = {
      text: request.prompt,
      provider: request.provider,
      model: request.model,
      voice: request.voice,
    };
    this.assertExtensionMatchesProvider(outputPath, speechRequest);
    const speechResult = await this.speechService.synthesize(speechRequest);
    this.assertExtensionMatchesMime(outputPath, speechResult.mimeType);
    await this.writeAudio(outputPath, speechResult.audioData, request.overwrite === true);

    return {
      path: outputPath,
      type,
      provider: speechResult.provider,
      model: speechResult.model,
      voice: speechResult.voice,
      mimeType: speechResult.mimeType,
      textLength: request.prompt.length,
      audioSize: speechResult.audioData.byteLength,
      ...(ignored.length > 0 ? { note: `${ignored.join(' and ')} ignored for speech.` } : {}),
    };
  }

  private resolveType(request: GenerateAudioRequest): AudioType {
    const type: string | undefined = request.type ?? (request.mode === 'voice' ? 'speech' : request.mode);
    if (type === undefined) return 'speech';
    if (type !== 'speech' && type !== 'music' && type !== 'sfx') {
      throw new Error(`Unsupported audio type "${String(type)}". Use speech, music or sfx.`);
    }
    return type;
  }

  private async generateMusicOrEffect(
    type: GeneratedAudioType,
    request: GenerateAudioRequest,
    outputPath: string
  ): Promise<GenerateAudioResult> {
    const model = this.resolveGeneratedAudioModel(type, request);
    const { duration } = model;
    const notes: string[] = [];

    if (request.durationSeconds !== undefined) {
      if (duration.control === 'parameter' && (request.durationSeconds < duration.minSeconds || request.durationSeconds > duration.maxSeconds)) {
        throw new Error(`${model.id} takes durationSeconds from ${duration.minSeconds} to ${duration.maxSeconds}, not ${request.durationSeconds}.`);
      }
      if (duration.control === 'fixed') notes.push(`${model.id} always makes ${duration.seconds} seconds; durationSeconds ignored.`);
      if (duration.control === 'prompt') notes.push(`${model.id} treats durationSeconds as a request in the prompt, so the length can be far off.`);
    }
    if (request.instrumental !== undefined && !model.instrumental) notes.push('instrumental ignored for sound effects.');
    if (request.loop !== undefined && !model.supportsLoop) notes.push(`${model.id} cannot loop; loop ignored.`);
    if (request.voice) notes.push(`voice ignored for ${type}.`);

    // Fail before paying: every music and effect model here returns MP3.
    if (this.extensionOf(outputPath) !== 'mp3') {
      throw new Error(`outputPath extension ".${this.extensionOf(outputPath)}" does not match what ${model.id} returns: use ".mp3".`);
    }

    const output = await generateAudioWithProvider({
      model,
      prompt: request.prompt,
      durationSeconds: request.durationSeconds,
      instrumental: request.instrumental,
      loop: request.loop,
      apiKey: this.getGeneratedAudioKey(model),
    });

    this.assertExtensionMatchesMime(outputPath, output.mimeType);
    await this.writeAudio(outputPath, output.audioData, request.overwrite === true);

    return {
      path: outputPath,
      type,
      provider: model.provider,
      model: model.id,
      mimeType: output.mimeType,
      textLength: request.prompt.length,
      audioSize: output.audioData.byteLength,
      ...(output.text ? { lyrics: output.text } : {}),
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    };
  }

  /** An explicit model wins, then an explicit provider, then the first configured model. */
  private resolveGeneratedAudioModel(type: GeneratedAudioType, request: GenerateAudioRequest): GeneratedAudioModelDeclaration {
    const { llmSettings, appsSettings } = this.options;
    const available = listConfiguredGeneratedAudioModels(llmSettings, appsSettings, type);
    const label = type === 'sfx' ? 'Sound effects' : 'Music';
    const summary = available.map(model => `${model.id} on ${model.provider}`).join(', ');
    if (available.length === 0) {
      throw new Error(type === 'sfx'
        ? 'Sound effects need an ElevenLabs key, and none is configured.'
        : 'Music needs an ElevenLabs, Google or OpenRouter key, and none is configured.');
    }
    const match = available.find(model =>
      (!request.model || model.id === request.model) && (!request.provider || model.provider === request.provider)
    );
    if (!match) {
      const asked = request.model ? `with ${request.model}${request.provider ? ` on ${request.provider}` : ''}` : `on ${request.provider ?? 'this provider'}`;
      throw new Error(`${label} ${type === 'sfx' ? 'are' : 'is'} not available ${asked}. Available: ${summary}.`);
    }
    return match;
  }

  private getGeneratedAudioKey(model: GeneratedAudioModelDeclaration): string {
    const key = model.provider === 'elevenlabs'
      ? this.options.appsSettings?.apps?.elevenlabs?.credentials?.apiKey
      : this.options.llmSettings?.providers?.[model.provider]?.apiKey;
    if (!key) throw new Error(`No ${model.provider} API key is configured.`);
    return key;
  }

  private normalizeOutputPath(outputPath: string): string {
    if (!outputPath.trim()) {
      throw new Error('outputPath is required.');
    }

    if (!tryResolveVaultPath(outputPath).ok) {
      throw new Error(`Invalid outputPath "${outputPath}". Use a vault-relative path with no ".." or absolute path segments.`);
    }

    return normalizePath(outputPath);
  }

  /**
   * Fail fast (before synthesis) when the outputPath does not end in a supported
   * audio extension. Mirrors VideoGenerationService.validateOutputExtension,
   * generalized to the allowed audio set instead of a single .mp4.
   */
  private validateOutputExtension(outputPath: string): void {
    const extension = this.extensionOf(outputPath);
    if (!extension || !ALLOWED_AUDIO_EXTENSIONS.includes(extension)) {
      throw new Error(
        `outputPath must end with one of: ${ALLOWED_AUDIO_EXTENSIONS.map(ext => `.${ext}`).join(', ')}.`
      );
    }
  }

  /**
   * Fail before synthesis when the provider will return a different file type
   * than the path names, so the mistake is not paid for. A request that cannot
   * resolve is left for synthesize() to report.
   */
  private assertExtensionMatchesProvider(outputPath: string, request: SpeechSynthesisRequest): void {
    let provider: SpeechProvider;
    let model: string;
    try {
      ({ provider, model } = this.speechService.resolveRequest(request));
    } catch {
      return;
    }

    const expected = getSpeechOutputExtension(provider, model);
    const actual = this.extensionOf(outputPath);
    if (actual !== expected) {
      throw new Error(`outputPath extension ".${actual}" does not match what ${model} on ${provider} returns: use ".${expected}".`);
    }
  }

  /**
   * Reject a write whose path extension does not match the actually synthesized
   * audio format, so e.g. Google's audio/wav bytes can never be written to a
   * .mp3 path (BE-m1). An unmapped mimeType fails with a clear error rather than
   * silently passing — covers any future adapter that returns a new format.
   */
  private assertExtensionMatchesMime(outputPath: string, mimeType: string): void {
    const expectedExtension = AUDIO_MIME_TO_EXTENSION[mimeType.toLowerCase()];
    if (!expectedExtension) {
      throw new Error(
        `Synthesized audio has an unsupported mimeType "${mimeType}". Supported: ${Object.keys(AUDIO_MIME_TO_EXTENSION).join(', ')}.`
      );
    }

    const actualExtension = this.extensionOf(outputPath);
    if (actualExtension !== expectedExtension) {
      throw new Error(
        `outputPath extension ".${actualExtension}" does not match the synthesized audio format "${mimeType}" (expected ".${expectedExtension}").`
      );
    }
  }

  /** Lowercased file extension without the leading dot, or '' if none. */
  private extensionOf(path: string): string {
    const lastDot = path.lastIndexOf('.');
    const lastSlash = path.lastIndexOf('/');
    if (lastDot <= lastSlash + 1) {
      return '';
    }
    return path.substring(lastDot + 1).toLowerCase();
  }

  private async writeAudio(outputPath: string, audioData: ArrayBuffer, overwrite: boolean): Promise<void> {
    const existingFile = this.vault.getAbstractFileByPath(outputPath);
    if (existingFile && !overwrite) {
      throw new Error(`File already exists at ${outputPath}. Set overwrite: true to replace.`);
    }

    await this.ensureParentDirectory(outputPath);

    if (!existingFile) {
      await this.vault.createBinary(outputPath, audioData);
      return;
    }

    const tempPath = `${outputPath}.generating`;
    await this.vault.createBinary(tempPath, audioData);
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
