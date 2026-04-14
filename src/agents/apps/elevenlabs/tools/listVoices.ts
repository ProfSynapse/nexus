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
import { verbs } from '../../../utils/toolStatusLabels';
import type { ToolStatusTense } from '../../../interfaces/ITool';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;

const getRecord = (value: unknown): UnknownRecord | undefined =>
  isRecord(value) ? value : undefined;

const getString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const getStatusCode = (value: unknown): number | undefined => {
  const record = getRecord(value);
  return typeof record?.status === 'number' ? record.status : undefined;
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

    const apiKey = this.agent.getCredential('apiKey');
    if (!apiKey) {
      const missing = this.agent.getMissingCredentials().map(c => c.label);
      return this.prepareResult(false, undefined,
        `ElevenLabs not configured. Missing: ${missing.join(', ')}. Set up in Nexus Settings → Apps.`);
    }

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
          `ElevenLabs API error (${response.status}): ${typeof response.text === 'string' ? response.text : 'Unknown error'}`);
      }

      const responseData = getRecord(response.json as unknown);
      const rawVoices = Array.isArray(responseData?.voices) ? responseData.voices : [];
      let voices: VoiceInfo[] = rawVoices.map((voice): VoiceInfo => {
        const voiceRecord = getRecord(voice);
        return {
          voice_id: getString(voiceRecord?.voice_id),
          name: getString(voiceRecord?.name),
          category: getString(voiceRecord?.category),
          description: getString(voiceRecord?.description),
          labels: isRecord(voiceRecord?.labels) ? voiceRecord.labels as Record<string, string> : undefined,
          preview_url: getString(voiceRecord?.preview_url),
        };
      });

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
      const status = getStatusCode(error);
      const body = getErrorMessage(error);
      return this.prepareResult(false, undefined,
        `Failed to list voices${status !== undefined ? ` (${status})` : ''}: ${body}`);
    }
  }

  getStatusLabel(_params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    const v = verbs('Listing voices', 'Listed voices', 'Failed to list voices');
    return v[tense];
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
