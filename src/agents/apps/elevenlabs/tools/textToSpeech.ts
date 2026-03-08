/**
 * TextToSpeechTool — Convert text to speech audio using ElevenLabs.
 *
 * POST /v1/text-to-speech/{voice_id}
 * Saves the resulting audio as an MP3 file in the vault.
 */

import { BaseTool } from '../../../baseTool';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import { BaseAppAgent } from '../../BaseAppAgent';
import { ElevenLabsAgent } from '../ElevenLabsAgent';
import { requestUrl, normalizePath, TFolder } from 'obsidian';

interface TextToSpeechParams extends CommonParameters {
  prompt: string;
  voiceId?: string;
  modelId?: string;
  outputPath?: string;
  stability?: number;
  similarityBoost?: number;
}

export class TextToSpeechTool extends BaseTool<TextToSpeechParams, CommonResult> {
  private agent: BaseAppAgent;

  constructor(agent: BaseAppAgent) {
    super(
      'textToSpeech',
      'Text to Speech',
      'Convert text to speech audio using ElevenLabs voices. Saves MP3 to vault.',
      '1.0.0'
    );
    this.agent = agent;
  }

  async execute(params: TextToSpeechParams): Promise<CommonResult> {
    if (!this.agent.hasRequiredCredentials()) {
      const missing = this.agent.getMissingCredentials().map(c => c.label);
      return this.prepareResult(false, undefined,
        `ElevenLabs not configured. Missing: ${missing.join(', ')}. Set up in Nexus Settings → Apps.`);
    }

    const apiKey = this.agent.getCredential('apiKey')!;
    const voiceId = params.voiceId || 'EXAVITQu4vr4xnSDxMaL'; // Default: Sarah
    const defaultModel = this.agent instanceof ElevenLabsAgent
      ? this.agent.getDefaultModelId()
      : 'eleven_multilingual_v2';
    const modelId = params.modelId || defaultModel;

    const body: Record<string, unknown> = {
      text: params.prompt,
      model_id: modelId,
    };

    if (params.stability !== undefined || params.similarityBoost !== undefined) {
      body.voice_settings = {
        stability: params.stability ?? 0.5,
        similarity_boost: params.similarityBoost ?? 0.75,
      };
    }

    try {
      const response = await requestUrl({
        url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify(body),
      });

      if (response.status !== 200) {
        return this.prepareResult(false, undefined,
          `ElevenLabs API error (${response.status}): ${response.text || 'Unknown error'}`);
      }

      const vault = this.agent.getVault();
      if (!vault) {
        return this.prepareResult(false, undefined,
          'Vault not available — cannot save audio file.');
      }

      const outputPath = normalizePath(params.outputPath || `audio/tts-${Date.now()}.mp3`);

      // Ensure parent directory exists
      const dir = outputPath.substring(0, outputPath.lastIndexOf('/'));
      if (dir && !vault.getAbstractFileByPath(dir)) {
        try {
          await vault.createFolder(dir);
        } catch {
          // Folder may already exist due to race condition
          if (!(vault.getAbstractFileByPath(dir) instanceof TFolder)) throw new Error(`Failed to create directory: ${dir}`);
        }
      }

      await vault.createBinary(outputPath, response.arrayBuffer);

      return this.prepareResult(true, {
        path: outputPath,
        voiceId,
        modelId,
        textLength: params.prompt.length,
        audioSize: response.arrayBuffer.byteLength,
      });
    } catch (error: unknown) {
      const status = (error as Record<string, unknown>)?.status;
      const body = (error as Record<string, unknown>)?.text
        ?? (error as Record<string, unknown>)?.message
        ?? String(error);
      return this.prepareResult(false, undefined,
        `Text-to-speech failed${status ? ` (${status})` : ''}: ${body}`);
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text prompt to convert to speech. Supports dialogue tags like [fearful], [whispered], etc.' },
        voiceId: { type: 'string', description: 'ElevenLabs voice ID (use listVoices to find IDs). Defaults to Sarah.' },
        modelId: { type: 'string', description: 'Model ID. Options: eleven_multilingual_v2 (default), eleven_turbo_v2 (faster), eleven_monolingual_v1' },
        outputPath: { type: 'string', description: 'Output file path in vault (default: audio/tts-{timestamp}.mp3)' },
        stability: { type: 'number', description: 'Voice stability 0.0-1.0 (default: 0.5)' },
        similarityBoost: { type: 'number', description: 'Voice similarity boost 0.0-1.0 (default: 0.75)' },
      },
      required: ['prompt'],
    });
  }
}
