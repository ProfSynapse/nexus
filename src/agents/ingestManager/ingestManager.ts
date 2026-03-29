/**
 * Location: src/agents/ingestManager/ingestManager.ts
 * Purpose: IngestManager agent — PDF and audio file ingestion with LLM OCR and transcription.
 * Extends BaseAgent with lazy tool registration following the CanvasManager/TaskManager pattern.
 *
 * Used by: ToolManager (Two-Tool Architecture), AgentRegistrationService
 * Dependencies: Vault, LLMProviderManager (injected via constructor)
 */

import { Vault } from 'obsidian';
import { BaseAgent } from '../baseAgent';
import { IngestTool } from './tools/ingestTool';
import { ListCapabilitiesTool } from './tools/listCapabilitiesTool';
import type { LLMProviderManager } from '../../services/llm/providers/ProviderManager';

/**
 * Agent for ingesting PDF and audio files into structured markdown notes.
 *
 * Tools (2 total):
 * - ingest: Process a PDF or audio file → create markdown note with extracted content
 * - listCapabilities: List available OCR and transcription providers and models
 *
 * PDF modes:
 * - text (default, free): pdfjs-dist text extraction via getTextContent()
 * - vision: Renders pages to PNG → sends to vision LLM for OCR
 *
 * Audio: Transcription via OpenAI/Groq Whisper API with timestamped segments.
 */
export class IngestManagerAgent extends BaseAgent {
  private vault: Vault;
  private getProviderManager: () => LLMProviderManager | null;

  constructor(
    vault: Vault,
    getProviderManager: () => LLMProviderManager | null
  ) {
    super(
      'ingestManager',
      'File ingestion — PDF and audio. Two modes for PDF: text extraction (free, default) or ' +
      'vision-based OCR (uses LLM). Audio transcription via Whisper (OpenAI/Groq). ' +
      'Creates markdown notes alongside source files with ![[embed]] links. ' +
      '2 tools: ingest (process file → markdown note), listCapabilities (available providers).',
      '1.0.0'
    );

    this.vault = vault;
    this.getProviderManager = getProviderManager;

    this.registerLazyTool({
      slug: 'ingest',
      name: 'Ingest File',
      description:
        'Ingest a PDF or audio file into a structured markdown note. ' +
        'PDF: text extraction (default) or vision OCR. ' +
        'Audio: Whisper transcription with timestamps. ' +
        'Output note created alongside the original file.',
      version: '1.0.0',
      factory: () => new IngestTool(this.vault, this.getProviderManager),
    });

    this.registerLazyTool({
      slug: 'listCapabilities',
      name: 'List Ingest Capabilities',
      description:
        'List available OCR providers (vision-capable models) and ' +
        'transcription providers (Whisper API). Use before ingest to discover options.',
      version: '1.0.0',
      factory: () => new ListCapabilitiesTool(this.getProviderManager),
    });
  }
}
