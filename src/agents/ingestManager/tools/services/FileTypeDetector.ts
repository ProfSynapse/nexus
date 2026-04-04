/**
 * Location: src/agents/ingestManager/tools/services/FileTypeDetector.ts
 * Purpose: Detect file type (PDF, DOCX, PPTX, XLSX, or audio) from file extension.
 *
 * Used by: IngestionPipelineService, IngestTool
 * Dependencies: None (pure utility)
 */

import { FileTypeInfo } from '../../types';

const PDF_EXTENSIONS = new Set(['.pdf']);
const DOCX_EXTENSIONS = new Set(['.docx']);
const PPTX_EXTENSIONS = new Set(['.pptx']);
const XLSX_EXTENSIONS = new Set(['.xlsx']);

const AUDIO_EXTENSIONS = new Map<string, string>([
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.ogg', 'audio/ogg'],
  ['.opus', 'audio/opus'],
  ['.flac', 'audio/flac'],
  ['.webm', 'audio/webm'],
  ['.mp4', 'audio/mp4'],
  ['.wma', 'audio/x-ms-wma'],
]);

/**
 * Detect file type from extension.
 * Returns null if the file type is not supported for ingestion.
 */
export function detectFileType(filePath: string): FileTypeInfo | null {
  const dotIndex = filePath.lastIndexOf('.');
  if (dotIndex === -1) return null;

  const ext = filePath.slice(dotIndex).toLowerCase();

  if (PDF_EXTENSIONS.has(ext)) {
    return { type: 'pdf', mimeType: 'application/pdf', extension: ext };
  }

  if (DOCX_EXTENSIONS.has(ext)) {
    return {
      type: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extension: ext
    };
  }

  if (PPTX_EXTENSIONS.has(ext)) {
    return {
      type: 'pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      extension: ext
    };
  }

  if (XLSX_EXTENSIONS.has(ext)) {
    return {
      type: 'xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: ext
    };
  }

  const audioMime = AUDIO_EXTENSIONS.get(ext);
  if (audioMime) {
    return { type: 'audio', mimeType: audioMime, extension: ext };
  }

  return null;
}

/**
 * Get all supported file extensions for display/filtering.
 */
export function getSupportedExtensions(): {
  pdf: string[];
  docx: string[];
  pptx: string[];
  xlsx: string[];
  audio: string[];
} {
  return {
    pdf: Array.from(PDF_EXTENSIONS),
    docx: Array.from(DOCX_EXTENSIONS),
    pptx: Array.from(PPTX_EXTENSIONS),
    xlsx: Array.from(XLSX_EXTENSIONS),
    audio: Array.from(AUDIO_EXTENSIONS.keys()),
  };
}

/**
 * Check if a given file path is a supported ingestible type.
 */
export function isSupportedFile(filePath: string): boolean {
  return detectFileType(filePath) !== null;
}
