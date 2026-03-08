/**
 * ElevenLabsAgent — AI voice generation app.
 *
 * Provides text-to-speech, voice listing, and sound effect generation
 * via the ElevenLabs API. Requires an API key from elevenlabs.io.
 */

import { BaseAppAgent } from '../BaseAppAgent';
import { AppManifest } from '../../../types/apps/AppTypes';
import { TextToSpeechTool } from './tools/textToSpeech';
import { ListVoicesTool } from './tools/listVoices';
import { SoundEffectsTool } from './tools/soundEffects';
import { CommonResult } from '../../../types';
import { requestUrl } from 'obsidian';

const ELEVENLABS_MANIFEST: AppManifest = {
  id: 'elevenlabs',
  name: 'ElevenLabs',
  description: 'AI voice generation — text-to-speech, voice listing, and sound effects',
  version: '1.0.0',
  author: 'Nexus',
  docsUrl: 'https://elevenlabs.io/docs',
  credentials: [
    {
      key: 'apiKey',
      label: 'API Key',
      type: 'password',
      required: true,
      description: 'Get your API key from elevenlabs.io → Profile + API Key',
      placeholder: 'sk_...',
    },
  ],
  tools: [
    { slug: 'textToSpeech', description: 'Convert text to speech audio' },
    { slug: 'listVoices', description: 'List available voices' },
    { slug: 'soundEffects', description: 'Generate sound effects from text descriptions' },
  ],
};

export class ElevenLabsAgent extends BaseAppAgent {
  constructor() {
    super(ELEVENLABS_MANIFEST);

    this.registerTool(new TextToSpeechTool(this));
    this.registerTool(new ListVoicesTool(this));
    this.registerTool(new SoundEffectsTool(this));
  }

  /**
   * Validate the API key by hitting the /v1/user endpoint.
   */
  async validateCredentials(): Promise<CommonResult> {
    const baseValidation = await super.validateCredentials();
    if (!baseValidation.success) return baseValidation;

    const apiKey = this.getCredential('apiKey')!;

    try {
      const response = await requestUrl({
        url: 'https://api.elevenlabs.io/v1/user',
        method: 'GET',
        headers: { 'xi-api-key': apiKey },
      });

      const user = response.json;
      return {
        success: true,
        data: {
          subscription: user.subscription?.tier || 'unknown',
          characterCount: user.subscription?.character_count,
          characterLimit: user.subscription?.character_limit,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Invalid API key or ElevenLabs API unreachable: ${error}`,
      };
    }
  }
}
