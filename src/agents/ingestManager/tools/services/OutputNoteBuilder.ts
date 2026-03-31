/**
 * Location: src/agents/ingestManager/tools/services/OutputNoteBuilder.ts
 * Purpose: Build markdown output notes from extracted/transcribed content.
 * Format: ![[source-file]] embed at top, then extracted content with page/timestamp/sheet sections.
 *
 * Used by: IngestionPipelineService
 * Dependencies: types (PdfPageContent, PptxSlideContent, SpreadsheetSheetContent, TranscriptionSegment)
 */

import {
  PdfPageContent,
  PptxSlideContent,
  SpreadsheetSheetContent,
  TranscriptionSegment
} from '../../types';

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
 * Build a markdown note from DOCX content.
 */
export function buildDocxNote(sourceFileName: string, markdown: string): string {
  const lines: string[] = [];

  lines.push(`![[${sourceFileName}]]`);

  if (markdown.trim()) {
    lines.push('');
    lines.push(markdown.trim());
  }

  lines.push('');

  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Build a markdown note from PPTX slide text and notes.
 */
export function buildPptxNote(sourceFileName: string, slides: PptxSlideContent[]): string {
  const lines: string[] = [];

  lines.push(`![[${sourceFileName}]]`);
  lines.push('');

  for (const slide of slides) {
    lines.push(`## Slide ${slide.slideNumber}`);
    lines.push('');

    if (slide.text.trim()) {
      lines.push(slide.text.trim());
      lines.push('');
    } else {
      lines.push('_No extractable slide text._');
      lines.push('');
    }

    if (slide.notes?.trim()) {
      lines.push('### Notes');
      lines.push('');
      lines.push(slide.notes.trim());
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Build a markdown note from a single XLSX sheet.
 */
export function buildSpreadsheetSheetNote(
  sourceFileName: string,
  sheet: SpreadsheetSheetContent
): string {
  const lines: string[] = [];

  lines.push(`![[${sourceFileName}]]`);
  lines.push('');

  lines.push(`# ${sheet.sheetName}`);
  lines.push('');

  if (sheet.rows.length === 0 || sheet.totalColumns === 0) {
    lines.push('_Empty sheet._');
    lines.push('');
    return lines.join('\n').trimEnd() + '\n';
  }

  const visibleColumnCount = Math.max(
    1,
    sheet.rows.reduce((maxColumns, row) => Math.max(maxColumns, row.length), 0)
  );

  const headers = ['Row'];
  for (let columnIndex = 0; columnIndex < visibleColumnCount; columnIndex += 1) {
    headers.push(`Column ${columnIndex + 1}`);
  }

  lines.push(createMarkdownRow(headers));
  lines.push(createMarkdownRow(headers.map(() => '---')));

  sheet.rows.forEach((row, rowIndex) => {
    const cells = [String(rowIndex + 1)];
    for (let columnIndex = 0; columnIndex < visibleColumnCount; columnIndex += 1) {
      cells.push(row[columnIndex] ?? '');
    }
    lines.push(createMarkdownRow(cells));
  });

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

function createMarkdownRow(cells: string[]): string {
  const escapedCells = cells.map(cell => escapeMarkdownTableCell(cell));
  return `| ${escapedCells.join(' | ')} |`;
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}
