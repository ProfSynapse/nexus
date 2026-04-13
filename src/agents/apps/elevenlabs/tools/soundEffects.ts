/**
 * SoundEffectsTool — Generate sound effects from text descriptions.
 *
 * POST /v1/sound-generation
 * Creates cinematic sound effects from text prompts.
 */

import { BaseTool } from '../../../baseTool';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { BaseAppAgent } from '../../BaseAppAgent';
import { requestUrl, normalizePath, TFolder } from 'obsidian';
import { labelNamed, verbs } from '../../../utils/toolStatusLabels';
import type { ToolStatusTense } from '../../../interfaces/ITool';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;

const getStatusCode = (value: unknown): number | undefined => {
  if (!isRecord(value)) return undefined;
  return typeof value.status === 'number' ? value.status : undefined;
};

const getErrorMessage = (value: unknown): string => {
  if (isRecord(value)) {
    const text = value.text;
    if (typeof text === 'string') return text;

    const message = value.message;
    if (typeof message === 'string') return message;
  }

  return String(value);
};

interface SoundEffectsParams extends CommonParameters {
  prompt: string;
  durationSeconds?: number;
  promptInfluence?: number;
  outputPath?: string;
}

export class SoundEffectsTool extends BaseTool<SoundEffectsParams, CommonResult> {
  private agent: BaseAppAgent;

  constructor(agent: BaseAppAgent) {
    super(
      'soundEffects',
      'Sound Effects',
      'Generate cinematic sound effects from text descriptions (e.g., "thunder rolling across a mountain valley").',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(params: SoundEffectsParams): Promise<CommonResult> {
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
      text: params.prompt,
    };

    if (params.durationSeconds !== undefined) {
      body.duration_seconds = Math.max(0.5, Math.min(30, params.durationSeconds));
    }
    if (params.promptInfluence !== undefined) {
      body.prompt_influence = Math.max(0, Math.min(1, params.promptInfluence));
    }

    try {
      const response = await requestUrl({
        url: 'https://api.elevenlabs.io/v1/sound-generation',
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify(body),
      });

      if (response.status !== 200) {
        const errorText = typeof response.text === 'string' ? response.text : 'Unknown error';
        return this.prepareResult(false, undefined,
          `ElevenLabs API error (${response.status}): ${errorText}`);
      }

      const vault = this.agent.getVault();
      if (!vault) {
        return this.prepareResult(false, undefined,
          'Vault not available — cannot save audio file.');
      }

      const outputPath = normalizePath(params.outputPath || `audio/sfx-${Date.now()}.mp3`);

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
        durationSeconds: params.durationSeconds,
        audioSize: response.arrayBuffer.byteLength,
      });
    } catch (error: unknown) {
      const status = getStatusCode(error);
      const body = getErrorMessage(error);
      return this.prepareResult(false, undefined,
        `Sound effect generation failed${status !== undefined ? ` (${status})` : ''}: ${body}`);
    }
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelNamed(verbs('Generating sound effect', 'Generated sound effect', 'Failed to generate sound effect'), params, tense, ['prompt']);
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text description of the sound effect to generate (e.g., "ocean waves crashing on rocks")' },
        durationSeconds: { type: 'number', description: 'Duration in seconds (0.5-30). If omitted, optimal duration is guessed from prompt.' },
        promptInfluence: { type: 'number', description: 'How closely to follow the text prompt (0.0-1.0)' },
        outputPath: { type: 'string', description: 'Output file path in vault (default: audio/sfx-{timestamp}.mp3)' },
      },
      required: ['prompt'],
    });
  }
}
