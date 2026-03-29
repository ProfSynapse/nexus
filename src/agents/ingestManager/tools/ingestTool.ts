/**
 * Location: src/agents/ingestManager/tools/ingestTool.ts
 * Purpose: IngestTool — accepts a file path and options, orchestrates the ingestion pipeline.
 * Creates a markdown note alongside the source file with extracted/transcribed content.
 *
 * Used by: IngestManagerAgent (via lazy tool registration)
 * Dependencies: IngestionPipelineService, LLMProviderManager, Vault
 */

import { Vault } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { IngestToolParameters, IngestToolResult } from '../types';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import { createErrorMessage } from '../../../utils/errorUtils';
import { processFile, PipelineDeps } from './services/IngestionPipelineService';
import type { LLMProviderManager } from '../../../services/llm/providers/ProviderManager';

export class IngestTool extends BaseTool<IngestToolParameters, IngestToolResult> {
  constructor(
    private vault: Vault,
    private getProviderManager: () => LLMProviderManager | null
  ) {
    super(
      'ingest',
      'Ingest File',
      'Ingest a PDF or audio file into a structured markdown note. ' +
      'PDF supports text extraction (default, free) or vision-based OCR (requires provider/model). ' +
      'Audio supports transcription via OpenAI, Groq, Google Gemini, and OpenRouter audio-capable models. ' +
      'The output note is created alongside the original file with an ![[embed]] link.',
      '1.0.0'
    );
  }

  async execute(params: IngestToolParameters): Promise<IngestToolResult> {
    try {
      if (!params.filePath) {
        return this.prepareResult(false, undefined, 'filePath is required');
      }

      const providerManager = this.getProviderManager();
      if (!providerManager) {
        return this.prepareResult(false, undefined, 'LLM provider manager not available');
      }

      const llmService = providerManager.getLLMService();

      const deps: PipelineDeps = {
        vault: this.vault,
        ocrDeps: {
          generateWithVision: async (messages, provider, model) => {
            const adapter = llmService.getAdapter(provider);
            if (!adapter) {
              throw new Error(`Provider "${provider}" not configured or not available`);
            }
            const response = await adapter.generateUncached('', {
              model,
              conversationHistory: messages as Array<{ role: string; content: unknown }>,
              temperature: 0.1,
            });
            return response.text;
          },
          getApiKey: (provider) => {
            const settings = providerManager.getSettings();
            return settings?.providers?.[provider]?.apiKey;
          },
          getOpenRouterHeaders: () => {
            const openRouterConfig = providerManager.getSettings()?.providers?.openrouter;
            return {
              httpReferer: openRouterConfig?.httpReferer,
              xTitle: openRouterConfig?.xTitle
            };
          }
        },
        transcriptionDeps: {
          getApiKey: (provider) => {
            const settings = providerManager.getSettings();
            return settings?.providers?.[provider]?.apiKey;
          },
          getOpenRouterHeaders: () => {
            const openRouterConfig = providerManager.getSettings()?.providers?.openrouter;
            return {
              httpReferer: openRouterConfig?.httpReferer,
              xTitle: openRouterConfig?.xTitle
            };
          }
        }
      };

      const result = await processFile(params, deps);
      return result;
    } catch (error) {
      return {
        success: false,
        error: createErrorMessage('Ingestion failed: ', error),
      };
    }
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file to ingest (PDF or audio). Relative to vault root.',
        },
        mode: {
          type: 'string',
          enum: ['text', 'vision'],
          description: 'PDF processing mode. "text" = free text extraction (default). "vision" = OCR via LLM vision (requires ocrProvider + ocrModel).',
        },
        ocrProvider: {
          type: 'string',
          description: 'Provider for vision-based OCR (e.g., "openai", "anthropic", "google", "ollama"). Required when mode="vision".',
        },
        ocrModel: {
          type: 'string',
          description: 'Model for vision-based OCR (e.g., "gpt-4o", "claude-sonnet-4-6"). Required when mode="vision".',
        },
        transcriptionProvider: {
          type: 'string',
          description: 'Provider for audio transcription. Supported: "openai", "groq", "google", "openrouter". Required for audio files.',
        },
        transcriptionModel: {
          type: 'string',
          description: 'Model for audio transcription (e.g., "gpt-4o-transcribe", "whisper-large-v3-turbo", "gemini-2.5-flash"). Optional — defaults to the provider\'s first supported transcription model.',
        },
      },
      required: ['filePath'],
    });
  }

  getResultSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        outputPath: { type: 'string', description: 'Path to the created markdown note' },
        pageCount: { type: 'number', description: 'Number of PDF pages processed (PDF only)' },
        durationSeconds: { type: 'number', description: 'Audio duration in seconds (audio only)' },
        processingTimeMs: { type: 'number', description: 'Total processing time in milliseconds' },
        warnings: {
          type: 'array',
          items: { type: 'string' },
          description: 'Non-fatal warnings (e.g., empty pages)',
        },
        error: { type: 'string' },
      },
    };
  }
}
