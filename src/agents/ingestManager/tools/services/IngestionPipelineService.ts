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
import { tryResolveVaultPath } from '../../../../core/vaultPath';
import {
  IngestFileRequest,
  IngestToolResult,
  IngestProgressCallback,
  PdfPageContent,
  OcrExtractedImage,
  TranscriptionSegment,
} from '../../types';
import { detectFileType } from './FileTypeDetector';
import { extractDocxMarkdown } from './DocxExtractionService';
import { extractPdfText } from './PdfTextExtractor';
import { extractPptxContent } from './PptxExtractionService';
import { ocrPdf, OcrServiceDeps } from './OcrService';
import {
  buildAudioNote,
  buildDocxNote,
  buildPdfNote,
  buildPptxNote,
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
  // Confine the caller-supplied input path to the vault. The output note and any
  // OCR asset folder are both derived from this path, so confining it here keeps
  // every downstream write inside the vault.
  const resolvedInput = tryResolveVaultPath(request.filePath);
  if (!resolvedInput.ok) {
    return { success: false, error: resolvedInput.error };
  }
  const filePath = resolvedInput.path;
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
      error: 'Unsupported file type. Supported: PDF, DOCX, PPTX, MP3, WAV, M4A, OGG, FLAC, WEBM, AAC',
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
    return {
      success: false,
      error: 'Unsupported file type.',
    };
  }

  onProgress?.({ filePath, stage: 'building' });

  const outputPaths: string[] = [];
  for (const noteWrite of noteWrites) {
    // Defence in depth: confine the derived output note path to the vault.
    const resolvedOutput = tryResolveVaultPath(noteWrite.outputPath);
    if (!resolvedOutput.ok) {
      return { success: false, error: resolvedOutput.error };
    }
    const normalizedOutput = resolvedOutput.path;
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
  let images: OcrExtractedImage[] = [];

  if (mode === 'vision') {
    onProgress?.({ filePath, stage: 'extracting', progress: 0 });

    const provider = request.ocrProvider;
    const model = request.ocrModel;
    if (!provider || !model) {
      throw new Error('Vision mode requires ocrProvider and ocrModel parameters');
    }

    const ocrResult = await ocrPdf(
      fileData,
      provider,
      model,
      deps.ocrDeps,
      (current, total) => {
        const progress = Math.round((current / total) * 100);
        onProgress?.({ filePath, stage: 'extracting', progress });
      }
    );
    pages = ocrResult.pages;
    images = ocrResult.images;
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

  // Save any embedded OCR images into a per-note asset folder and rewrite the
  // markdown refs to Obsidian embeds. The folder is namespaced by the source
  // file, so images from different PDFs (both named "img-0.jpeg") never collide.
  if (images.length > 0) {
    const saved = await saveOcrImages(images, filePath, deps.vault);
    if (saved.length > 0) {
      pages = pages.map(page => ({
        ...page,
        // Match refs against only this page's images — native Mistral reuses
        // ids like "img-0.jpeg" across pages.
        text: rewriteImageRefs(page.text, saved.filter(s => s.pageNumber === page.pageNumber)),
      }));
    }
    if (saved.length < images.length) {
      warnings.push(
        `${images.length - saved.length} OCR image(s) could not be saved.`
      );
    }
  }

  const content = buildPdfNote(fileName, pages);
  return { content, pageCount: pages.length, warnings };
}

interface SavedOcrImage {
  pageNumber: number;
  refId: string;
  vaultPath: string;
}

/**
 * Decode and write OCR images into a per-note asset folder next to the output
 * note. For "notes/report.pdf" the folder is "notes/report/", so re-ingesting
 * overwrites deterministically and cross-document names never collide.
 */
async function saveOcrImages(
  images: OcrExtractedImage[],
  sourceFilePath: string,
  vault: Vault
): Promise<SavedOcrImage[]> {
  // Defence in depth: confine the per-note OCR asset folder to the vault.
  const assetFolderResult = tryResolveVaultPath(buildAssetFolderPath(sourceFilePath));
  if (!assetFolderResult.ok) {
    return [];
  }
  const assetFolder = assetFolderResult.path;
  await ensureFolder(vault, assetFolder);

  const saved: SavedOcrImage[] = [];
  for (let i = 0; i < images.length; i++) {
    const decoded = decodeDataUrl(images[i].dataUrl);
    if (!decoded) continue;

    const fileName = `img-${i}.${decoded.extension}`;
    const vaultPath = normalizePath(`${assetFolder}/${fileName}`);

    const existing = vault.getFileByPath(vaultPath);
    if (existing instanceof TFile) {
      await vault.modifyBinary(existing, decoded.bytes);
    } else {
      await vault.createBinary(vaultPath, decoded.bytes);
    }

    saved.push({ pageNumber: images[i].pageNumber, refId: images[i].refId, vaultPath });
  }

  return saved;
}

/** Rewrite markdown `![alt](refId)` image links into Obsidian `![[vaultPath]]` embeds. */
function rewriteImageRefs(text: string, saved: SavedOcrImage[]): string {
  let result = text;
  for (const img of saved) {
    const escaped = img.refId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`!\\[[^\\]]*\\]\\(\\s*${escaped}\\s*(?:\\s+"[^"]*")?\\)`, 'g');
    result = result.replace(re, `![[${img.vaultPath}]]`);
  }
  return result;
}

/** "notes/report.pdf" -> "notes/report" (per-note asset folder). */
function buildAssetFolderPath(sourceFilePath: string): string {
  const normalized = normalizePath(sourceFilePath);
  const dotIndex = normalized.lastIndexOf('.');
  const base = dotIndex === -1 ? normalized : normalized.slice(0, dotIndex);
  return base;
}

/** Ensure a folder (and its ancestors) exists in the vault. */
async function ensureFolder(vault: Vault, folderPath: string): Promise<void> {
  const normalized = normalizePath(folderPath);
  if (!normalized || normalized === '/' || normalized === '.') return;
  if (vault.getFolderByPath(normalized)) return;

  const segments = normalized.split('/').filter(Boolean);
  let current = '';
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (vault.getFolderByPath(current)) continue;
    try {
      await vault.createFolder(current);
    } catch {
      // Race or already-exists — safe to ignore; verified on next iteration.
    }
  }
}

/** Decode a base64 data URL into bytes plus a file extension derived from its MIME. */
function decodeDataUrl(
  dataUrl: string
): { bytes: ArrayBuffer; extension: string } | null {
  const match = /^data:([^;,]+)?(?:;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!match) return null;

  const mime = (match[1] || 'image/png').toLowerCase();
  const base64 = match[2];
  if (!base64) return null;

  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return { bytes: bytes.buffer, extension: mimeToExtension(mime) };
}

function mimeToExtension(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpeg',
    'image/jpg': 'jpeg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'image/svg+xml': 'svg',
  };
  if (map[mime]) return map[mime];
  const subtype = mime.split('/')[1] || 'png';
  return subtype.replace(/[^a-z0-9]/g, '') || 'png';
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

/** Audio MIME types accepted by the transcription pipeline. */
const SUPPORTED_AUDIO_MIME_TYPES = new Set([
  'audio/mpeg',
  'audio/wav',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/opus',
  'audio/flac',
  'audio/webm',
  'audio/x-ms-wma',
]);

/** Process an audio file (transcription) */
async function processAudio(
  fileData: ArrayBuffer,
  fileName: string,
  mimeType: string,
  request: IngestFileRequest,
  deps: PipelineDeps
): Promise<{ content: string; durationSeconds?: number }> {
  if (!SUPPORTED_AUDIO_MIME_TYPES.has(mimeType)) {
    throw new Error(
      `Unsupported audio format "${mimeType}". ` +
      `Supported: ${Array.from(SUPPORTED_AUDIO_MIME_TYPES).join(', ')}`
    );
  }

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
 * Example: "notes/report.pdf" -> "notes/report.md"
 */
function buildOutputPath(filePath: string): string {
  const dotIndex = filePath.lastIndexOf('.');
  if (dotIndex === -1) return filePath + '.md';
  return filePath.slice(0, dotIndex) + '.md';
}
