/**
 * Location: src/agents/ingestManager/tools/listCapabilitiesTool.ts
 * Purpose: ListCapabilitiesTool — returns which configured providers support OCR and transcription.
 * Helps the LLM (or user) choose the right provider/model for ingestion.
 *
 * Used by: IngestManagerAgent (via lazy tool registration)
 * Dependencies: LLMProviderManager
 */

import { BaseTool } from '../../baseTool';
import { verbs } from '../../utils/toolStatusLabels';
import type { ToolStatusTense } from '../../interfaces/ITool';
import {
  ListCapabilitiesParameters,
  ListCapabilitiesResult,
  ProviderCapabilityInfo,
} from '../types';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import { createErrorMessage } from '../../../utils/errorUtils';
import type { LLMProviderManager } from '../../../services/llm/providers/ProviderManager';
import { getIngestCapabilityOptions } from './services/IngestCapabilityService';

export class ListCapabilitiesTool extends BaseTool<ListCapabilitiesParameters, ListCapabilitiesResult> {
  constructor(private getProviderManager: () => LLMProviderManager | null) {
    super(
      'listCapabilities',
      'List Ingest Capabilities',
      'List available OCR and transcription providers and models. ' +
      'OCR providers expose explicit OCR models. ' +
      'Transcription providers expose explicit speech or audio-capable ingest models.',
      '1.0.0'
    );
  }

  getStatusLabel(_params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    const v = verbs('Listing ingest capabilities', 'Listed ingest capabilities', 'Failed to list ingest capabilities');
    return v[tense];
  }

  async execute(_params: ListCapabilitiesParameters): Promise<ListCapabilitiesResult> {
    try {
      const providerManager = this.getProviderManager();
      if (!providerManager) {
        return this.prepareResult(false, undefined, 'LLM provider manager not available');
      }

      const capabilities = await getIngestCapabilityOptions(providerManager);
      const ocrProviders: ProviderCapabilityInfo[] = capabilities.ocrProviders.map(provider => ({
        provider: provider.id,
        models: provider.models.map(model => model.id)
      }));
      const transcriptionProviders: ProviderCapabilityInfo[] = capabilities.transcriptionProviders.map(provider => ({
        provider: provider.id,
        models: provider.models.map(model => model.id)
      }));

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
              description: 'Providers with explicit OCR models for PDF ingestion',
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
              description: 'Providers that support audio transcription via explicit ingest models',
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
