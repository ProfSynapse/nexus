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
import { TranscriptionService } from '../../../services/llm/TranscriptionService';
import { getTranscriptionProviders } from '../../../services/llm/types/VoiceTypes';

export class IngestTool extends BaseTool<IngestToolParameters, IngestToolResult> {
  private cachedTranscriptionService: TranscriptionService | null = null;
  private cachedSettingsHash: string | null = null;

  constructor(
    private vault: Vault,
    private getProviderManager: () => LLMProviderManager | null
  ) {
    super(
      'ingest',
      'Ingest File',
      buildToolDescription(),
      '1.0.0'
    );
  }

  async execute(params: IngestToolParameters): Promise<IngestToolResult> {
    try {
      // Refresh description to reflect any newly enabled providers
      this.description = buildToolDescription();

      if (!params.filePath) {
        return this.prepareResult(false, undefined, 'filePath is required');
      }

      const providerManager = this.getProviderManager();
      if (!providerManager) {
        return this.prepareResult(false, undefined, 'LLM provider manager not available');
      }

      const llmService = providerManager.getLLMService();
      const transcriptionService = this.getOrCreateTranscriptionService(providerManager);

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
        transcriptionService
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
    const providers = getTranscriptionProviders();
    const providerList = providers.join(', ');

    return this.getMergedSchema({
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file to ingest (PDF, DOCX, PPTX, XLSX, or audio). Relative to vault root.',
        },
        mode: {
          type: 'string',
          enum: ['text', 'vision'],
          description: 'PDF processing mode only. "text" = free text extraction (default). "vision" = OCR via LLM vision (requires ocrProvider + ocrModel).',
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
          enum: [...providers],
          description: `Provider for audio transcription. Supported: ${providerList}. Required for audio files.`,
        },
        transcriptionModel: {
          type: 'string',
          description: 'Model for audio transcription (e.g., "whisper-1", "whisper-large-v3-turbo", "voxtral-mini-latest"). Optional — defaults to the provider\'s first supported transcription model.',
        },
      },
      required: ['filePath'],
    });
  }

  /**
   * Cache TranscriptionService — recreate only when provider settings change.
   */
  private getOrCreateTranscriptionService(providerManager: LLMProviderManager): TranscriptionService {
    const settings = providerManager.getSettings();
    const hash = computeSettingsHash(settings);

    if (this.cachedTranscriptionService && this.cachedSettingsHash === hash) {
      return this.cachedTranscriptionService;
    }

    this.cachedTranscriptionService = new TranscriptionService(settings);
    this.cachedSettingsHash = hash;
    return this.cachedTranscriptionService;
  }

  getResultSchema(): JSONSchema {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        outputPath: { type: 'string', description: 'Path to the created markdown note' },
        outputPaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths to the created markdown notes. XLSX files may generate one note per sheet.'
        },
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

/**
 * Build the tool description dynamically from the transcription provider registry.
 */
function buildToolDescription(): string {
  const providers = getTranscriptionProviders();
  const providerNames = providers.map(p => formatProviderName(p));
  const providerList = providerNames.length > 0
    ? providerNames.join(', ')
    : 'no transcription providers configured';

  return (
    'Ingest a PDF, DOCX, PPTX, XLSX, or audio file into a structured markdown note. ' +
    'PDF supports text extraction (default, free) or vision-based OCR (requires provider/model). ' +
    'DOCX, PPTX, and XLSX convert directly to markdown without an LLM call. ' +
    `Audio supports transcription via ${providerList}. ` +
    'The output note is created alongside the original file with an ![[embed]] link.'
  );
}

/** Human-readable provider name from provider ID. */
function formatProviderName(provider: string): string {
  const nameMap: Record<string, string> = {
    openai: 'OpenAI',
    groq: 'Groq',
    google: 'Google Gemini',
    openrouter: 'OpenRouter',
    mistral: 'Mistral',
    deepgram: 'Deepgram',
    assemblyai: 'AssemblyAI',
  };
  return nameMap[provider] ?? provider;
}

/**
 * Compute a simple hash of provider settings relevant to TranscriptionService.
 * Used to detect when the cached service needs to be recreated.
 */
function computeSettingsHash(settings: unknown): string {
  if (!settings || typeof settings !== 'object') return '';
  const s = settings as Record<string, unknown>;
  const providers = s.providers;
  if (!providers || typeof providers !== 'object') return '';

  // Hash provider enabled/apiKey state — lightweight, no crypto needed
  const parts: string[] = [];
  for (const [key, value] of Object.entries(providers as Record<string, unknown>)) {
    if (value && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      parts.push(`${key}:${String(v.enabled ?? '')}:${String(v.apiKey ?? '').length}`);
    }
  }
  return parts.sort().join('|');
}
