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
import { requestUrl } from 'obsidian';

interface SoundEffectsParams extends CommonParameters {
  text: string;
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

    const apiKey = this.agent.getCredential('apiKey')!;

    const body: Record<string, unknown> = {
      text: params.text,
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

      const outputPath = params.outputPath || `audio/sfx-${Date.now()}.mp3`;

      return this.prepareResult(true, {
        path: outputPath,
        prompt: params.text,
        durationSeconds: params.durationSeconds,
        audioSize: response.arrayBuffer.byteLength,
      });
    } catch (error) {
      return this.prepareResult(false, undefined, `Sound effect generation failed: ${error}`);
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text description of the sound effect to generate (e.g., "ocean waves crashing on rocks")' },
        durationSeconds: { type: 'number', description: 'Duration in seconds (0.5-30). If omitted, optimal duration is guessed from prompt.' },
        promptInfluence: { type: 'number', description: 'How closely to follow the text prompt (0.0-1.0)' },
        outputPath: { type: 'string', description: 'Output file path in vault (default: audio/sfx-{timestamp}.mp3)' },
      },
      required: ['text'],
    });
  }
}
