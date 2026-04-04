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
  IngestProgressCallback,
  PdfPageContent,
  SpreadsheetSheetContent,
  TranscriptionSegment,
} from '../../types';
import { detectFileType } from './FileTypeDetector';
import { extractDocxMarkdown } from './DocxExtractionService';
import { extractPdfText } from './PdfTextExtractor';
import { extractPptxContent } from './PptxExtractionService';
import { ocrPdf, OcrServiceDeps } from './OcrService';
import {
  extractSpreadsheetSheets,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS
} from './SpreadsheetExtractionService';
import {
  buildAudioNote,
  buildDocxNote,
  buildPdfNote,
  buildPptxNote,
  buildSpreadsheetSheetNote
} from './OutputNoteBuilder';
import { TranscriptionService } from '../../../../services/llm/TranscriptionService';
import { getTranscriptionProviders, type TranscriptionProvider } from '../../../../services/llm/types/VoiceTypes';

export interface PipelineDeps {
  vault: Vault;
  ocrDeps: OcrServiceDeps;
  transcriptionService: TranscriptionService;
}

interface NoteWrite {
  outputPath: string;
  content: string;
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
      error: 'Unsupported file type. Supported: PDF, DOCX, PPTX, XLSX, MP3, WAV, M4A, OGG, FLAC, WEBM, AAC',
    };
  }

  // Read binary data
  const fileData = await deps.vault.readBinary(file);

  // Route by file type
  let noteWrites: NoteWrite[];
  let pageCount: number | undefined;
  let durationSeconds: number | undefined;

  if (fileType.type === 'pdf') {
    const result = await processPdf(
      fileData, file.name, request, deps, onProgress, filePath
    );
    noteWrites = [{ outputPath: buildOutputPath(filePath), content: result.content }];
    pageCount = result.pageCount;
    if (result.warnings) warnings.push(...result.warnings);
  } else if (fileType.type === 'audio') {
    onProgress?.({ filePath, stage: 'transcribing', progress: 0 });

    const result = await processAudio(
      fileData, file.name, fileType.mimeType, request, deps
    );
    noteWrites = [{ outputPath: buildOutputPath(filePath), content: result.content }];
    durationSeconds = result.durationSeconds;

    onProgress?.({ filePath, stage: 'transcribing', progress: 100 });
  } else if (fileType.type === 'docx') {
    onProgress?.({ filePath, stage: 'extracting', progress: 0 });
    const result = await processDocx(fileData, file.name);
    noteWrites = [{ outputPath: buildOutputPath(filePath), content: result.content }];
    if (result.warnings) warnings.push(...result.warnings);
    onProgress?.({ filePath, stage: 'extracting', progress: 100 });
  } else if (fileType.type === 'pptx') {
    onProgress?.({ filePath, stage: 'extracting', progress: 0 });
    const result = await processPptx(fileData, file.name);
    noteWrites = [{ outputPath: buildOutputPath(filePath), content: result.content }];
    if (result.warnings) warnings.push(...result.warnings);
    onProgress?.({ filePath, stage: 'extracting', progress: 100 });
  } else {
    onProgress?.({ filePath, stage: 'extracting', progress: 0 });
    const result = processSpreadsheet(fileData, file.name, filePath);
    noteWrites = result.notes;
    if (result.warnings) warnings.push(...result.warnings);
    onProgress?.({ filePath, stage: 'extracting', progress: 100 });
  }

  onProgress?.({ filePath, stage: 'building' });

  const outputPaths: string[] = [];
  for (const noteWrite of noteWrites) {
    const normalizedOutput = normalizePath(noteWrite.outputPath);
    const existingFile = deps.vault.getFileByPath(normalizedOutput);

    if (existingFile) {
      await deps.vault.modify(existingFile, noteWrite.content);
    } else {
      await deps.vault.create(normalizedOutput, noteWrite.content);
    }

    outputPaths.push(normalizedOutput);
  }

  onProgress?.({ filePath, stage: 'complete', progress: 100 });

  return {
    success: true,
    outputPath: outputPaths[0],
    outputPaths,
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

/** Process a DOCX file */
async function processDocx(
  fileData: ArrayBuffer,
  fileName: string
): Promise<{ content: string; warnings?: string[] }> {
  const result = await extractDocxMarkdown(fileData);

  return {
    content: buildDocxNote(fileName, result.markdown),
    warnings: result.warnings.length > 0 ? result.warnings : undefined
  };
}

/** Process a PPTX file */
async function processPptx(
  fileData: ArrayBuffer,
  fileName: string
): Promise<{ content: string; warnings?: string[] }> {
  const result = await extractPptxContent(fileData);

  return {
    content: buildPptxNote(fileName, result.slides),
    warnings: result.warnings.length > 0 ? result.warnings : undefined
  };
}

/** Process an XLSX file */
function processSpreadsheet(
  fileData: ArrayBuffer,
  fileName: string,
  filePath: string
): { notes: NoteWrite[]; warnings?: string[] } {
  const sheets = extractSpreadsheetSheets(fileData);
  const validSheets: SpreadsheetSheetContent[] = [];
  const warnings: string[] = [];

  for (const sheet of sheets) {
    if (sheet.totalColumns > MAX_SHEET_COLUMNS || sheet.totalRows > MAX_SHEET_ROWS) {
      warnings.push(
        `Skipped sheet "${sheet.sheetName}" because it exceeds the spreadsheet limit ` +
        `(${sheet.totalColumns} columns x ${sheet.totalRows} rows; max ${MAX_SHEET_COLUMNS} x ${MAX_SHEET_ROWS}).`
      );
      continue;
    }

    validSheets.push(sheet);
  }

  if (validSheets.length === 0) {
    throw new Error(
      `No sheets were converted. All sheets exceed the spreadsheet limit ` +
      `(max ${MAX_SHEET_COLUMNS} columns x ${MAX_SHEET_ROWS} rows).`
    );
  }

  return {
    notes: validSheets.map((sheet) => ({
      outputPath: buildSpreadsheetSheetOutputPath(filePath, sheet.sheetName),
      content: buildSpreadsheetSheetNote(fileName, sheet)
    })),
    warnings: warnings.length > 0 ? warnings : undefined
  };
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
      `Supported: ${getTranscriptionProviders().join(', ')}`
    );
  }

  const transcription = await deps.transcriptionService.transcribe({
    audioData: fileData,
    mimeType,
    fileName,
    provider: provider as TranscriptionProvider,
    model,
    requestWordTimestamps: true
  });

  const segments: TranscriptionSegment[] = transcription.segments.map(segment => ({
    startSeconds: segment.startSeconds,
    endSeconds: segment.endSeconds,
    text: segment.text
  }));

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

function buildSpreadsheetSheetOutputPath(filePath: string, sheetName: string): string {
  const basePath = buildOutputPath(filePath).replace(/\.md$/i, '');
  const safeSheetName = sanitizeSheetNameForPath(sheetName);
  return `${basePath} - ${safeSheetName}.md`;
}

function sanitizeSheetNameForPath(sheetName: string): string {
  const sanitized = sheetName
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return sanitized || 'Sheet';
}
