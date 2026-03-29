/**
 * Location: src/agents/ingestManager/tools/services/IngestionPipelineService.ts
 * Purpose: Orchestrates the full ingestion pipeline for a single file.
 * Routes PDF files to text extraction or vision OCR, audio files to transcription,
 * then builds output notes and saves them to the vault.
 *
 * Used by: IngestTool
 * Dependencies: FileTypeDetector, PdfTextExtractor, OcrService, TranscriptionService,
 *               OutputNoteBuilder, Vault (Obsidian)
 */

import { Vault, TFile, normalizePath } from 'obsidian';
import {
  IngestFileRequest,
  IngestToolResult,
  IngestProgress,
  IngestProgressCallback,
  PdfPageContent,
  TranscriptionSegment,
} from '../../types';
import { detectFileType } from './FileTypeDetector';
import { extractPdfText } from './PdfTextExtractor';
import { ocrPdf, OcrServiceDeps } from './OcrService';
import { transcribeAudio, TranscriptionServiceDeps } from './TranscriptionService';
import { buildPdfNote, buildAudioNote } from './OutputNoteBuilder';
import { getIngestionProvidersForKind } from './IngestModelCatalog';

export interface PipelineDeps {
  vault: Vault;
  ocrDeps: OcrServiceDeps;
  transcriptionDeps: TranscriptionServiceDeps;
}

/**
 * Process a single file through the ingestion pipeline.
 */
export async function processFile(
  request: IngestFileRequest,
  deps: PipelineDeps,
  onProgress?: IngestProgressCallback
): Promise<IngestToolResult> {
  const startTime = Date.now();
  const filePath = normalizePath(request.filePath);
  const warnings: string[] = [];

  // Validate file exists
  const file = deps.vault.getFileByPath(filePath);
  if (!file || !(file instanceof TFile)) {
    return {
      success: false,
      error: `File not found: ${filePath}`,
    };
  }

  // Detect file type
  const fileType = detectFileType(filePath);
  if (!fileType) {
    return {
      success: false,
      error: `Unsupported file type. Supported: PDF, MP3, WAV, M4A, OGG, FLAC, WEBM, AAC`,
    };
  }

  // Read binary data
  const fileData = await deps.vault.readBinary(file);

  // Route by file type
  let noteContent: string;
  let pageCount: number | undefined;
  let durationSeconds: number | undefined;

  if (fileType.type === 'pdf') {
    const result = await processPdf(
      fileData, file.name, request, deps, onProgress, filePath
    );
    noteContent = result.content;
    pageCount = result.pageCount;
    if (result.warnings) warnings.push(...result.warnings);
  } else {
    onProgress?.({ filePath, stage: 'transcribing', progress: 0 });

    const result = await processAudio(
      fileData, file.name, fileType.mimeType, request, deps
    );
    noteContent = result.content;
    durationSeconds = result.durationSeconds;

    onProgress?.({ filePath, stage: 'transcribing', progress: 100 });
  }

  // Build output path: same folder as original, with .md extension
  onProgress?.({ filePath, stage: 'building' });
  const outputPath = buildOutputPath(filePath);

  // Create the output note
  const normalizedOutput = normalizePath(outputPath);
  const existingFile = deps.vault.getFileByPath(normalizedOutput);

  if (existingFile) {
    // Overwrite existing note
    await deps.vault.modify(existingFile as TFile, noteContent);
  } else {
    await deps.vault.create(normalizedOutput, noteContent);
  }

  onProgress?.({ filePath, stage: 'complete', progress: 100 });

  return {
    success: true,
    outputPath: normalizedOutput,
    pageCount,
    durationSeconds,
    processingTimeMs: Date.now() - startTime,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/** Process a PDF file (text extraction or vision OCR) */
async function processPdf(
  fileData: ArrayBuffer,
  fileName: string,
  request: IngestFileRequest,
  deps: PipelineDeps,
  onProgress: IngestProgressCallback | undefined,
  filePath: string
): Promise<{ content: string; pageCount: number; warnings?: string[] }> {
  const mode = request.mode || 'text';
  const warnings: string[] = [];

  let pages: PdfPageContent[];

  if (mode === 'vision') {
    onProgress?.({ filePath, stage: 'extracting', progress: 0 });

    const provider = request.ocrProvider;
    const model = request.ocrModel;
    if (!provider || !model) {
      throw new Error('Vision mode requires ocrProvider and ocrModel parameters');
    }

    pages = await ocrPdf(
      fileData,
      provider,
      model,
      deps.ocrDeps,
      (current, total) => {
        const progress = Math.round((current / total) * 100);
        onProgress?.({ filePath, stage: 'extracting', progress });
      }
    );
  } else {
    onProgress?.({ filePath, stage: 'extracting', progress: 0 });
    pages = await extractPdfText(fileData);
    onProgress?.({ filePath, stage: 'extracting', progress: 100 });
  }

  // Warn if text extraction yielded empty pages
  const emptyPages = pages.filter(p => !p.text.trim());
  if (emptyPages.length > 0 && mode === 'text') {
    warnings.push(
      `${emptyPages.length} page(s) had no extractable text. ` +
      `Try vision mode for scanned PDFs.`
    );
  }

  const content = buildPdfNote(fileName, pages);
  return { content, pageCount: pages.length, warnings };
}

/** Process an audio file (transcription) */
async function processAudio(
  fileData: ArrayBuffer,
  fileName: string,
  mimeType: string,
  request: IngestFileRequest,
  deps: PipelineDeps
): Promise<{ content: string; durationSeconds?: number }> {
  const provider = request.transcriptionProvider;
  const model = request.transcriptionModel;

  if (!provider) {
    throw new Error(
      'Audio transcription requires a transcriptionProvider. ' +
      `Supported: ${getIngestionProvidersForKind('transcription').join(', ')}`
    );
  }

  const segments: TranscriptionSegment[] = await transcribeAudio(
    fileData,
    mimeType,
    fileName,
    provider,
    model,
    deps.transcriptionDeps
  );

  const content = buildAudioNote(fileName, segments);
  const lastSegment = segments[segments.length - 1];
  const durationSeconds = lastSegment ? Math.ceil(lastSegment.endSeconds) : undefined;

  return { content, durationSeconds };
}

/**
 * Build the output .md path from the source file path.
 * Example: "notes/report.pdf" → "notes/report.md"
 */
function buildOutputPath(filePath: string): string {
  const dotIndex = filePath.lastIndexOf('.');
  if (dotIndex === -1) return filePath + '.md';
  return filePath.slice(0, dotIndex) + '.md';
}
