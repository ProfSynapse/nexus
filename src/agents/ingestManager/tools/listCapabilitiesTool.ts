/**
 * Location: src/agents/ingestManager/tools/listCapabilitiesTool.ts
 * Purpose: ListCapabilitiesTool — returns which configured providers support OCR and transcription.
 * Helps the LLM (or user) choose the right provider/model for ingestion.
 *
 * Used by: IngestManagerAgent (via lazy tool registration)
 * Dependencies: LLMProviderManager
 */

import { BaseTool } from '../../baseTool';
import {
  ListCapabilitiesParameters,
  ListCapabilitiesResult,
  ProviderCapabilityInfo,
} from '../types';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import { createErrorMessage } from '../../../utils/errorUtils';
import type { LLMProviderManager } from '../../../services/llm/providers/ProviderManager';
import { getTranscriptionProviders } from './services/TranscriptionService';

/** Providers that can never do OCR (no vision support possible) */
const NON_VISION_PROVIDERS = new Set(['webllm', 'perplexity']);

export class ListCapabilitiesTool extends BaseTool<ListCapabilitiesParameters, ListCapabilitiesResult> {
  constructor(private getProviderManager: () => LLMProviderManager | null) {
    super(
      'listCapabilities',
      'List Ingest Capabilities',
      'List available OCR and transcription providers and models. ' +
      'OCR providers have vision-capable models. ' +
      'Transcription providers support the Whisper audio API (OpenAI, Groq).',
      '1.0.0'
    );
  }

  async execute(params: ListCapabilitiesParameters): Promise<ListCapabilitiesResult> {
    try {
      const providerManager = this.getProviderManager();
      if (!providerManager) {
        return this.prepareResult(false, undefined, 'LLM provider manager not available');
      }

      const settings = providerManager.getSettings();
      if (!settings?.providers) {
        return this.prepareResult(false, undefined, 'No providers configured');
      }

      // Build OCR providers list — providers with vision-capable models
      const llmService = providerManager.getLLMService();
      const ocrProviders: ProviderCapabilityInfo[] = [];
      for (const [providerId, config] of Object.entries(settings.providers)) {
        if (!config.enabled) continue;
        if (NON_VISION_PROVIDERS.has(providerId)) continue;

        try {
          const adapter = llmService.getAdapter(providerId);
          if (!adapter) continue;

          const models = await adapter.listModels();
          const visionModels = models
            .filter((m: { supportsImages?: boolean }) => m.supportsImages)
            .map((m: { id: string }) => m.id);

          if (visionModels.length > 0) {
            ocrProviders.push({ provider: providerId, models: visionModels });
          }
        } catch {
          // Provider not available, skip
        }
      }

      // Build transcription providers list — only Whisper-compatible
      const transcriptionProviderNames = getTranscriptionProviders();
      const transcriptionProviders: ProviderCapabilityInfo[] = [];

      for (const providerName of transcriptionProviderNames) {
        const config = settings.providers[providerName];
        if (!config?.enabled || !config.apiKey) continue;

        transcriptionProviders.push({
          provider: providerName,
          models: providerName === 'openai'
            ? ['whisper-1']
            : ['whisper-large-v3-turbo', 'whisper-large-v3'],
        });
      }

      return {
        success: true,
        capabilities: {
          ocrProviders,
          transcriptionProviders,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: createErrorMessage('Failed to list capabilities: ', error),
      };
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {},
    });
  }

  getResultSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        capabilities: {
          type: 'object',
          properties: {
            ocrProviders: {
              type: 'array',
              description: 'Providers with vision-capable models for PDF OCR',
              items: {
                type: 'object',
                properties: {
                  provider: { type: 'string' },
                  models: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            transcriptionProviders: {
              type: 'array',
              description: 'Providers that support audio transcription (Whisper API)',
              items: {
                type: 'object',
                properties: {
                  provider: { type: 'string' },
                  models: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        error: { type: 'string' },
      },
    };
  }
}
