/**
 * Location: src/agents/ingestManager/tools/services/OutputNoteBuilder.ts
 * Purpose: Build markdown output notes from extracted/transcribed content.
 * Format: ![[source-file]] embed at top, then extracted content with page/timestamp sections.
 *
 * Used by: IngestionPipelineService
 * Dependencies: types (PdfPageContent, TranscriptionSegment)
 */

import { PdfPageContent, TranscriptionSegment } from '../../types';

/**
 * Build a markdown note from PDF page content (text or vision mode).
 * Format:
 * ```
 * ![[report.pdf]]
 *
 * ## Page 1
 * [extracted text]
 * ```
 */
export function buildPdfNote(sourceFileName: string, pages: PdfPageContent[]): string {
  const lines: string[] = [];

  lines.push(`![[${sourceFileName}]]`);
  lines.push('');

  for (const page of pages) {
    if (pages.length > 1) {
      lines.push(`## Page ${page.pageNumber}`);
      lines.push('');
    }

    if (page.text) {
      lines.push(page.text);
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Build a markdown note from audio transcription segments.
 * Format:
 * ```
 * ![[recording.mp3]]
 *
 * [00:00:01] Hello and welcome...
 * [00:00:15] Today we're going to discuss...
 * ```
 */
export function buildAudioNote(
  sourceFileName: string,
  segments: TranscriptionSegment[]
): string {
  const lines: string[] = [];

  lines.push(`![[${sourceFileName}]]`);
  lines.push('');

  for (const segment of segments) {
    const timestamp = formatTimestamp(segment.startSeconds);
    lines.push(`${timestamp} ${segment.text}`);
  }

  lines.push('');

  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Format seconds as [HH:MM:SS].
 */
function formatTimestamp(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  return `[${hh}:${mm}:${ss}]`;
}
