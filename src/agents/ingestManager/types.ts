/**
 * Location: src/agents/ingestManager/types.ts
 * Purpose: Shared types for the Nexus Ingester agent — document, spreadsheet, PDF, and audio ingestion pipeline.
 *
 * Used by: IngestAgent, IngestTool, ListCapabilitiesTool, all ingestion services
 * Dependencies: CommonParameters, CommonResult from types
 */

import { CommonParameters, CommonResult } from '../../types';

export const ACCEPTED_PDF_EXTENSIONS = ['.pdf'] as const;
export const ACCEPTED_DOCX_EXTENSIONS = ['.docx'] as const;
export const ACCEPTED_PPTX_EXTENSIONS = ['.pptx'] as const;
export const ACCEPTED_XLSX_EXTENSIONS = ['.xlsx'] as const;
export const ACCEPTED_AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.webm', '.opus'] as const;
export const ACCEPTED_EXTENSIONS = [
  ...ACCEPTED_PDF_EXTENSIONS,
  ...ACCEPTED_DOCX_EXTENSIONS,
  ...ACCEPTED_PPTX_EXTENSIONS,
  ...ACCEPTED_XLSX_EXTENSIONS,
  ...ACCEPTED_AUDIO_EXTENSIONS
] as const;

// ─── File Detection ──────────────────────────────────────────────────────────

export type IngestFileType = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'audio';

export interface FileTypeInfo {
  type: IngestFileType;
  mimeType: string;
  extension: string;
}

// ─── Tool Parameters & Results ───────────────────────────────────────────────

export interface IngestFileRequest {
  filePath: string;
  mode?: 'text' | 'vision';
  ocrProvider?: string;
  ocrModel?: string;
  transcriptionProvider?: string;
  transcriptionModel?: string;
}

export interface IngestToolParameters extends CommonParameters, IngestFileRequest {}

export interface IngestToolResult extends CommonResult {
  outputPath?: string;
  outputPaths?: string[];
  pageCount?: number;
  durationSeconds?: number;
  processingTimeMs?: number;
  warnings?: string[];
}

export type ListCapabilitiesParameters = CommonParameters;

export interface IngestCapabilities {
  ocrProviders: ProviderCapabilityInfo[];
  transcriptionProviders: ProviderCapabilityInfo[];
}

export interface ListCapabilitiesResult extends CommonResult {
  capabilities?: IngestCapabilities;
}

export interface ProviderCapabilityInfo {
  provider: string;
  models: string[];
}

// ─── Progress Tracking ───────────────────────────────────────────────────────

export interface IngestProgress {
  filePath: string;
  stage: 'queued' | 'extracting' | 'transcribing' | 'building' | 'complete' | 'error';
  progress?: number;
  error?: string;
}

export type IngestProgressCallback = (progress: IngestProgress) => void;

// ─── PDF Services ────────────────────────────────────────────────────────────

export interface PdfPageContent {
  pageNumber: number;
  text: string;
}

export interface PdfPageImage {
  pageNumber: number;
  base64Png: string;
  width: number;
  height: number;
}

// ─── DOCX Services ───────────────────────────────────────────────────────────

export interface DocxExtractionResult {
  markdown: string;
  warnings: string[];
}

// ─── PPTX Services ───────────────────────────────────────────────────────────

export interface PptxSlideContent {
  slideNumber: number;
  text: string;
  notes?: string;
}

export interface PptxExtractionResult {
  slides: PptxSlideContent[];
  warnings: string[];
}

// ─── Spreadsheet Services ────────────────────────────────────────────────────

export interface SpreadsheetSheetContent {
  sheetName: string;
  rows: string[][];
  totalRows: number;
  totalColumns: number;
}

// ─── Audio Services ──────────────────────────────────────────────────────────

export interface AudioChunk {
  data: ArrayBuffer;
  mimeType: string;
  startSeconds: number;
  durationSeconds: number;
}

export interface TranscriptionSegment {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

// ─── Vision Message Formatting ───────────────────────────────────────────────

export type VisionProviderFamily = 'openai' | 'anthropic' | 'google' | 'ollama';

export interface VisionMessage {
  role: 'user';
  content: unknown;
  images?: string[];
}
