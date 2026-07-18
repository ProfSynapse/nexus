import { App, normalizePath, TFolder, Vault } from 'obsidian';
import type { AppsSettings } from '../../types/apps/AppTypes';
import type { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import { tryResolveVaultPath } from '../../core/vaultPath';
import { SpeechSynthesisService } from '../readAloud/SpeechSynthesisService';
import type { SpeechSynthesisRequest } from '../readAloud/SpeechSynthesisTypes';

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
  mode?: AudioGenerationMode;
  prompt: string;
  provider?: string;
  model?: string;
  voice?: string;
  outputPath: string;
  overwrite?: boolean;
}

export interface GenerateAudioResult {
  path: string;
  mode: AudioGenerationMode;
  provider: string;
  model: string;
  voice: string;
  mimeType: string;
  textLength: number;
  audioSize: number;
}

export interface AudioGenerationServiceOptions {
  llmSettings: LLMProviderSettings | null;
  appsSettings?: AppsSettings;
}

export class AudioGenerationService {
  private speechService: SpeechSynthesisService;

  constructor(
    private app: App,
    private vault: Vault,
    options: AudioGenerationServiceOptions
  ) {
    this.speechService = new SpeechSynthesisService(options.llmSettings, {
      appsSettings: options.appsSettings,
    });
  }

  async generate(request: GenerateAudioRequest): Promise<GenerateAudioResult> {
    const mode = request.mode ?? 'voice';
    if (mode !== 'voice') {
      throw new Error(`Unsupported audio generation mode "${String(mode)}". This version supports voice only.`);
    }

    if (!request.prompt.trim()) {
      throw new Error('Prompt is required.');
    }

    const outputPath = this.normalizeOutputPath(request.outputPath);
    this.validateOutputExtension(outputPath);
    const speechRequest: SpeechSynthesisRequest = {
      text: request.prompt,
      provider: request.provider,
      model: request.model,
      voice: request.voice,
    };
    const speechResult = await this.speechService.synthesize(speechRequest);
    this.assertExtensionMatchesMime(outputPath, speechResult.mimeType);
    await this.writeAudio(outputPath, speechResult.audioData, request.overwrite === true);

    return {
      path: outputPath,
      mode,
      provider: speechResult.provider,
      model: speechResult.model,
      voice: speechResult.voice,
      mimeType: speechResult.mimeType,
      textLength: request.prompt.length,
      audioSize: speechResult.audioData.byteLength,
    };
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
