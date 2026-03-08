/**
 * ElevenLabsAgent — AI voice generation app.
 *
 * Provides text-to-speech, voice listing, and sound effect generation
 * via the ElevenLabs API. Requires an API key from elevenlabs.io.
 */

import { BaseAppAgent, FetchTTSModelsResult } from '../BaseAppAgent';
import { AppManifest, ElevenLabsModel } from '../../../types/apps/AppTypes';
import { TextToSpeechTool } from './tools/textToSpeech';
import { ListVoicesTool } from './tools/listVoices';
import { SoundEffectsTool } from './tools/soundEffects';
import { MusicGenerationTool } from './tools/musicGeneration';
import { CommonResult } from '../../../types';
import { requestUrl } from 'obsidian';

const DEFAULT_TTS_MODEL = 'eleven_multilingual_v2';

const ELEVENLABS_MANIFEST: AppManifest = {
  id: 'elevenlabs',
  name: 'ElevenLabs',
  description: 'AI audio generation — text-to-speech, voice listing, sound effects, and music generation',
  version: '1.0.0',
  author: 'Nexus',
  docsUrl: 'https://elevenlabs.io/docs',
  credentials: [
    {
      key: 'apiKey',
      label: 'API Key',
      type: 'password',
      required: true,
      description: 'Get your API key from elevenlabs.io → Profile + API Key. Required permissions: Voices (voice listing), Text-to-Speech (TTS generation), Sound Effects (sound generation), Music (music generation). Optional: User (subscription info).',
      placeholder: 'sk_...',
    },
  ],
  tools: [
    { slug: 'textToSpeech', description: 'Convert text to speech audio' },
    { slug: 'listVoices', description: 'List available voices' },
    { slug: 'soundEffects', description: 'Generate sound effects from text descriptions' },
    { slug: 'generateMusic', description: 'Generate music from text prompts describing genre, mood, instruments, and lyrics' },
  ],
};

export class ElevenLabsAgent extends BaseAppAgent {
  constructor() {
    super(ELEVENLABS_MANIFEST);

    this.registerTool(new TextToSpeechTool(this));
    this.registerTool(new ListVoicesTool(this));
    this.registerTool(new SoundEffectsTool(this));
    this.registerTool(new MusicGenerationTool(this));
  }

  /**
   * Validate the API key by probing all endpoints the app uses.
   *
   * - /v1/voices (GET) — core, must pass for success
   * - /v1/text-to-speech/{voice_id} (POST) — 422 = auth ok, 401 = missing permission
   * - /v1/sound-generation (POST) — same pattern
   * - /v1/music (POST) — same pattern (may 404 on older plans)
   * - /v1/user (GET) — optional subscription info
   *
   * Returns per-capability permission status and lists any missing permissions.
   */
  async validateCredentials(): Promise<CommonResult> {
    const baseValidation = await super.validateCredentials();
    if (!baseValidation.success) return baseValidation;

    const apiKey = this.getCredential('apiKey')!;
    const headers = { 'xi-api-key': apiKey, 'Content-Type': 'application/json' };

    // --- 1. Voices (GET) — core validation ---
    let voiceCount = 0;
    let voicesOk = false;
    try {
      const response = await requestUrl({
        url: 'https://api.elevenlabs.io/v1/voices',
        method: 'GET',
        headers,
      });
      const voices: unknown[] = response.json?.voices || [];
      voiceCount = voices.length;
      voicesOk = true;
    } catch (error: unknown) {
      const status = (error as Record<string, unknown>)?.status;
      if (status === 401) {
        return {
          success: false,
          error: 'Invalid ElevenLabs API key. Check your key at elevenlabs.io → Profile + API Key.',
        };
      }
      console.error('[ElevenLabs] /v1/voices probe failed', { status });
    }

    if (!voicesOk) {
      return {
        success: false,
        error: 'ElevenLabs API key validation failed: could not access /v1/voices.',
      };
    }

    // --- 2. Probe generation endpoints with minimal payloads ---
    // A non-401 response (including 422, 400) means auth passed.
    // A 401 means the key lacks the required permission.
    const probeEndpoint = async (url: string, body: Record<string, unknown>): Promise<{ ok: boolean; missingPermission?: string }> => {
      try {
        await requestUrl({ url, method: 'POST', headers, body: JSON.stringify(body) });
        // 200 would be unexpected with empty payloads, but means auth passed
        return { ok: true };
      } catch (error: unknown) {
        const status = (error as Record<string, unknown>)?.status;
        if (status === 401) {
          // Try to extract permission name from error body
          let missingPermission: string | undefined;
          try {
            const errText = (error as Record<string, unknown>)?.text;
            if (typeof errText === 'string') {
              const parsed = JSON.parse(errText);
              const detail = parsed?.detail;
              if (typeof detail === 'object' && detail?.message) {
                // e.g. "...permission text_to_speech..."
                const match = String(detail.message).match(/permission\s+(\S+)/i);
                if (match) missingPermission = match[1];
              }
            }
          } catch {
            // Could not parse permission name — that's fine
          }
          return { ok: false, missingPermission };
        }
        // Any other error (400, 422, 404, etc.) means auth passed
        return { ok: true };
      }
    };

    // Use a dummy voice_id — the request will fail validation but auth check happens first
    const ttsResult = await probeEndpoint(
      'https://api.elevenlabs.io/v1/text-to-speech/dummy_voice_id',
      { text: '', model_id: 'eleven_monolingual_v1' }
    );

    const sfxResult = await probeEndpoint(
      'https://api.elevenlabs.io/v1/sound-generation',
      { text: '' }
    );

    const musicResult = await probeEndpoint(
      'https://api.elevenlabs.io/v1/music',
      { prompt: '' }
    );

    // --- 3. User info (GET, optional) ---
    let userInfoOk = false;
    let subscription = 'unknown (user permission not granted)';
    let characterCount: number | undefined;
    let characterLimit: number | undefined;

    try {
      const userResponse = await requestUrl({
        url: 'https://api.elevenlabs.io/v1/user',
        method: 'GET',
        headers,
      });
      if (userResponse.status === 200) {
        userInfoOk = true;
        const userData = userResponse.json;
        subscription = userData.subscription?.tier || 'unknown';
        characterCount = userData.subscription?.character_count;
        characterLimit = userData.subscription?.character_limit;
      }
    } catch {
      // Key lacks user permission — not critical
    }

    // --- 4. Build result ---
    const permissions: Record<string, boolean> = {
      voices: true, // Already confirmed above
      textToSpeech: ttsResult.ok,
      soundEffects: sfxResult.ok,
      music: musicResult.ok,
      userInfo: userInfoOk,
    };

    const missingPermissions: string[] = [];
    if (!ttsResult.ok) missingPermissions.push(ttsResult.missingPermission || 'text_to_speech');
    if (!sfxResult.ok) missingPermissions.push(sfxResult.missingPermission || 'sound_generation');
    if (!musicResult.ok) missingPermissions.push(musicResult.missingPermission || 'music_generation');
    if (!userInfoOk) missingPermissions.push('user');

    return {
      success: true,
      data: {
        voiceCount,
        subscription,
        characterCount,
        characterLimit,
        permissions,
        missingPermissions,
      },
    };
  }

  /**
   * Fetch TTS-capable models from the ElevenLabs API.
   * Filters out models that require alpha access.
   */
  async fetchTTSModels(): Promise<FetchTTSModelsResult> {
    if (!this.hasRequiredCredentials()) {
      return { success: false, error: 'API key not configured' };
    }

    const apiKey = this.getCredential('apiKey')!;

    try {
      const response = await requestUrl({
        url: 'https://api.elevenlabs.io/v1/models',
        method: 'GET',
        headers: { 'xi-api-key': apiKey },
      });

      const allModels: ElevenLabsModel[] = response.json || [];
      const ttsModels = allModels.filter(
        m => m.can_do_text_to_speech && !m.requires_alpha_access
      );

      return { success: true, models: ttsModels };
    } catch (error: unknown) {
      const status = (error as Record<string, unknown>)?.status;
      return {
        success: false,
        error: `Failed to fetch models${status ? ` (${status})` : ''}`
      };
    }
  }

  /**
   * Get the user's selected default TTS model ID, or fall back to eleven_multilingual_v2.
   */
  getDefaultModelId(): string {
    return this.getSetting('defaultTTSModel') || DEFAULT_TTS_MODEL;
  }
}
