/**
 * Location: src/agents/ingestManager/tools/services/PdfTextExtractor.ts
 * Purpose: Extract text content from PDF pages using pdfjs-dist getTextContent().
 * This is the default (free) PDF mode — no LLM API calls needed.
 *
 * Used by: IngestionPipelineService (text mode)
 * Dependencies: pdfjs-dist
 */

import { PdfPageContent } from '../../types';

/**
 * Extract text from all pages of a PDF file.
 * Uses pdfjs-dist's getTextContent() which runs on the main thread via LoopbackPort.
 */
export async function extractPdfText(pdfData: ArrayBuffer): Promise<PdfPageContent[]> {
  // Dynamic import to lazy-load pdfjs-dist (only when PDF ingestion is used)
  const pdfjsLib = await import('pdfjs-dist');

  // In esbuild platform:"node" builds, pdfjs-dist uses LoopbackPort automatically
  // when no workerSrc is set. This runs the worker code on the main thread.
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfData),
  });

  const pdf = await loadingTask.promise;
  const pageCount = pdf.numPages;
  const pages: PdfPageContent[] = [];

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();

    // Reconstruct text from items, preserving line breaks via hasEOL
    let text = '';
    for (const item of textContent.items) {
      if ('str' in item) {
        text += item.str;
        if ('hasEOL' in item && item.hasEOL) {
          text += '\n';
        }
      }
    }

    pages.push({
      pageNumber: i,
      text: text.trim(),
    });
  }

  return pages;
}
