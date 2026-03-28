/**
 * ListVoicesTool — List available ElevenLabs voices.
 *
 * GET /v1/voices
 * Returns voice IDs, names, categories, and descriptions.
 */

import { BaseTool } from '../../../baseTool';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { BaseAppAgent } from '../../BaseAppAgent';
import { requestUrl } from 'obsidian';

interface ListVoicesParams extends CommonParameters {
  category?: string;
}

interface VoiceInfo {
  voice_id: string;
  name: string;
  category: string;
  description?: string;
  labels?: Record<string, string>;
  preview_url?: string;
}

interface VoicesResponse {
  voices?: VoiceInfo[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isVoiceInfo(value: unknown): value is VoiceInfo {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.voice_id === 'string'
    && typeof value.name === 'string'
    && typeof value.category === 'string';
}

function parseVoicesResponse(value: unknown): VoicesResponse {
  if (!isRecord(value) || !Array.isArray(value.voices)) {
    return {};
  }

  return {
    voices: value.voices.filter(isVoiceInfo)
  };
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Error) {
    return value.message;
  }

  return String(value);
}

export class ListVoicesTool extends BaseTool<ListVoicesParams, CommonResult> {
  private agent: BaseAppAgent;

  constructor(agent: BaseAppAgent) {
    super(
      'listVoices',
      'List Voices',
      'List available ElevenLabs voices with their IDs, names, and categories.',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(params: ListVoicesParams): Promise<CommonResult> {
    if (!this.agent.hasRequiredCredentials()) {
      const missing = this.agent.getMissingCredentials().map(c => c.label);
      return this.prepareResult(false, undefined,
        `ElevenLabs not configured. Missing: ${missing.join(', ')}. Set up in Nexus Settings → Apps.`);
    }

    const apiKey = this.agent.getCredential('apiKey')!;

    try {
      const response = await requestUrl({
        url: 'https://api.elevenlabs.io/v1/voices',
        method: 'GET',
        headers: {
          'xi-api-key': apiKey,
        },
      });

      if (response.status !== 200) {
        return this.prepareResult(false, undefined,
          `ElevenLabs API error (${response.status}): ${response.text || 'Unknown error'}`);
      }

      const data = parseVoicesResponse(response.json);
      let voices: VoiceInfo[] = data.voices ?? [];

      // Filter by category if specified
      if (params.category) {
        voices = voices.filter(v => v.category === params.category);
      }

      // Map to concise format
      const voiceList = voices.map(v => ({
        id: v.voice_id,
        name: v.name,
        category: v.category,
        description: v.description || '',
        labels: v.labels || {},
      }));

      return this.prepareResult(true, {
        voices: voiceList,
        total: voiceList.length,
      });
    } catch (error: unknown) {
      const errorRecord = isRecord(error) ? error : undefined;
      const status = errorRecord?.status;
      const body = errorRecord?.text
        ?? errorRecord?.message
        ?? error;
      return this.prepareResult(false, undefined,
        `Failed to list voices${status !== undefined ? ` (${formatUnknown(status)})` : ''}: ${formatUnknown(body)}`);
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Filter by category: premade, cloned, generated, professional',
          enum: ['premade', 'cloned', 'generated', 'professional'],
        },
      },
      required: [],
    });
  }
}
