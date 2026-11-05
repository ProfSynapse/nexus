/**
 * MusicGenerationTool — Generate music from text prompts using ElevenLabs.
 *
 * POST /v1/music
 * Composes a song from a text prompt and saves the audio to the vault.
 */

import { BaseTool } from '../../../baseTool';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { BaseAppAgent } from '../../BaseAppAgent';
import { TFolder } from 'obsidian';
import { tryResolveVaultPath } from '../../../../core/vaultPath';
import { labelNamed, verbs } from '../../../utils/toolStatusLabels';
import type { ToolStatusTense } from '../../../interfaces/ITool';
import { ProviderHttpClient } from '../../../../services/llm/adapters/shared/ProviderHttpClient';

/** Sent explicitly: with no model_id the API falls back to music_v1, which it removes on 2027-01-31. */
const MUSIC_MODEL = 'music_v2_5';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;

const getErrorMessage = (value: unknown): string => {
  if (isRecord(value)) {
    const text = value.text;
    if (typeof text === 'string') return text;

    const message = value.message;
    if (typeof message === 'string') return message;
  }

  return String(value);
};

interface MusicGenerationParams extends CommonParameters {
  prompt: string;
  musicLengthMs?: number;
  outputPath?: string;
  outputFormat?: string;
  forceInstrumental?: boolean;
}

export class MusicGenerationTool extends BaseTool<MusicGenerationParams, CommonResult> {
  private agent: BaseAppAgent;

  constructor(agent: BaseAppAgent) {
    super(
      'generateMusic',
      'Generate Music',
      'Generate music from a text prompt describing genre, mood, instruments, tempo, and lyrics. Saves audio to vault.',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(params: MusicGenerationParams): Promise<CommonResult> {
    if (!this.agent.hasRequiredCredentials()) {
      const missing = this.agent.getMissingCredentials().map(c => c.label);
      return this.prepareResult(false, undefined,
        `ElevenLabs not configured. Missing: ${missing.join(', ')}. Set up in Nexus Settings → Apps.`);
    }

    const apiKey = this.agent.getCredential('apiKey');
    if (!apiKey) {
      const missing = this.agent.getMissingCredentials().map(c => c.label);
      return this.prepareResult(false, undefined,
        `ElevenLabs not configured. Missing: ${missing.join(', ')}. Set up in Nexus Settings → Apps.`);
    }

    const body: Record<string, unknown> = {
      prompt: params.prompt,
      model_id: MUSIC_MODEL,
    };

    if (params.musicLengthMs !== undefined) {
      body.music_length_ms = Math.max(3000, Math.min(600000, params.musicLengthMs));
    }
    if (params.forceInstrumental !== undefined) {
      body.force_instrumental = params.forceInstrumental;
    }

    const outputFormat = params.outputFormat || 'mp3_44100_128';

    try {
      const response = await ProviderHttpClient.requestOk({
        provider: 'elevenlabs',
        operation: 'music generation',
        timeoutMs: 600_000,
        responseType: 'binary',
        url: `https://api.elevenlabs.io/v1/music?output_format=${outputFormat}`,
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify(body),
      });

      const vault = this.agent.getVault();
      if (!vault) {
        return this.prepareResult(false, undefined,
          'Vault not available — cannot save audio file.');
      }

      // Confine to the vault: reject traversal/absolute/home-expansion paths.
      const resolvedOutput = tryResolveVaultPath(params.outputPath || `audio/music-${Date.now()}.mp3`);
      if (!resolvedOutput.ok) {
        return this.prepareResult(false, undefined, resolvedOutput.error);
      }
      const outputPath = resolvedOutput.path;

      // Ensure parent directory exists
      const dir = outputPath.substring(0, outputPath.lastIndexOf('/'));
      if (dir && !vault.getAbstractFileByPath(dir)) {
        try {
          await vault.createFolder(dir);
        } catch {
          if (!(vault.getAbstractFileByPath(dir) instanceof TFolder)) throw new Error(`Failed to create directory: ${dir}`);
        }
      }

      await vault.createBinary(outputPath, response.arrayBuffer);

      return this.prepareResult(true, {
        path: outputPath,
        prompt: params.prompt,
        musicLengthMs: params.musicLengthMs,
        audioSize: response.arrayBuffer.byteLength,
      });
    } catch (error: unknown) {
      return this.prepareResult(false, undefined, `Music generation failed: ${getErrorMessage(error)}`);
    }
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelNamed(verbs('Generating music', 'Generated music', 'Failed to generate music'), params, tense, ['prompt']);
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text description of the music to generate. Can define genre, mood, instruments, vocals, tempo, structure, and lyrics (max 4100 chars). Do NOT reference copyrighted artists or lyrics.' },
        musicLengthMs: { type: 'number', description: 'Length of the song in milliseconds (3000-600000, i.e. 3s to 10min). If omitted, the model chooses based on the prompt.' },
        outputPath: { type: 'string', description: 'Output file path in vault (default: audio/music-{timestamp}.mp3)' },
        outputFormat: { type: 'string', description: 'Audio format (default: mp3_44100_128). Options: mp3_22050_32, mp3_44100_64, mp3_44100_128, mp3_44100_192' },
        forceInstrumental: { type: 'boolean', description: 'If true, guarantees instrumental output with no vocals (default: false)' },
      },
      required: ['prompt'],
    });
  }
}
