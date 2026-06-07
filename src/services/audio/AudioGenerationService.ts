import { App, normalizePath, TFolder, Vault } from 'obsidian';
import type { AppsSettings } from '../../types/apps/AppTypes';
import type { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import { isValidPath } from '../../utils/pathUtils';
import { SpeechSynthesisService } from '../readAloud/SpeechSynthesisService';
import type { SpeechSynthesisRequest } from '../readAloud/SpeechSynthesisTypes';

export type AudioGenerationMode = 'voice';

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
    const speechRequest: SpeechSynthesisRequest = {
      text: request.prompt,
      provider: request.provider,
      model: request.model,
      voice: request.voice,
    };
    const speechResult = await this.speechService.synthesize(speechRequest);
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

    if (!isValidPath(outputPath)) {
      throw new Error(`Invalid outputPath "${outputPath}". Use a vault-relative path with no ".." or absolute path segments.`);
    }

    return normalizePath(outputPath);
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
