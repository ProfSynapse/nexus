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
import { TFolder } from 'obsidian';
import { tryResolveVaultPath } from '../../../../core/vaultPath';
import { labelNamed, verbs } from '../../../utils/toolStatusLabels';
import type { ToolStatusTense } from '../../../interfaces/ITool';
import { ProviderHttpClient } from '../../../../services/llm/adapters/shared/ProviderHttpClient';

/**
 * Sent explicitly: with no model_id the API falls back to eleven_text_to_sound_v2,
 * which it removes on 2027-03-01.
 */
const SOUND_EFFECTS_MODEL = 'eleven_text_to_sound_v3';

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

interface SoundEffectsParams extends CommonParameters {
  prompt: string;
  durationSeconds?: number;
  promptInfluence?: number;
  loop?: boolean;
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
      model_id: SOUND_EFFECTS_MODEL,
    };

    if (params.durationSeconds !== undefined) {
      body.duration_seconds = Math.max(0.5, Math.min(30, params.durationSeconds));
    }
    if (params.loop !== undefined) {
      body.loop = params.loop;
    }
    if (params.promptInfluence !== undefined) {
      body.prompt_influence = Math.max(0, Math.min(1, params.promptInfluence));
    }

    try {
      const response = await ProviderHttpClient.requestOk({
        provider: 'elevenlabs',
        operation: 'sound effect generation',
        timeoutMs: 300_000,
        responseType: 'binary',
        url: 'https://api.elevenlabs.io/v1/sound-generation',
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
      const resolvedOutput = tryResolveVaultPath(params.outputPath || `audio/sfx-${Date.now()}.mp3`);
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
        durationSeconds: params.durationSeconds,
        audioSize: response.arrayBuffer.byteLength,
      });
    } catch (error: unknown) {
      return this.prepareResult(false, undefined, `Sound effect generation failed: ${getErrorMessage(error)}`);
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
        loop: { type: 'boolean', description: 'If true, make a sound effect that loops smoothly (default: false)' },
        outputPath: { type: 'string', description: 'Output file path in vault (default: audio/sfx-{timestamp}.mp3)' },
      },
      required: ['prompt'],
    });
  }
}
