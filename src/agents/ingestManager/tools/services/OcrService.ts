/**
 * Location: src/agents/ingestManager/tools/services/OcrService.ts
 * Purpose: OCR service for PDF vision mode. Renders PDF pages to images,
 * formats them for the target provider's vision API, and extracts text via LLM.
 *
 * Used by: IngestionPipelineService (vision mode)
 * Dependencies: PdfPageRenderer, VisionMessageFormatter, LLM adapters
 */

import { PdfPageContent, PdfPageImage } from '../../types';
import { renderPdfPages } from './PdfPageRenderer';
import { formatVisionMessage, getProviderFamily } from './VisionMessageFormatter';

const DEFAULT_OCR_PROMPT =
  'Extract all text from this PDF page image. Preserve the original formatting, headings, and structure as closely as possible. Return only the extracted text, no commentary.';

export interface OcrServiceDeps {
  /** Call the LLM adapter's generate method with a vision message */
  generateWithVision: (
    messages: unknown[],
    provider: string,
    model: string
  ) => Promise<string>;
}

/** Maximum pages to OCR by default (each page = 1 LLM vision call) */
const DEFAULT_MAX_PAGES = 20;

/**
 * Process a PDF through vision-based OCR.
 * Renders each page to PNG, sends to a vision-capable LLM, and collects extracted text.
 * If the PDF exceeds maxPages, only the first N pages are processed and a
 * truncation note is appended.
 */
export async function ocrPdf(
  pdfData: ArrayBuffer,
  provider: string,
  model: string,
  deps: OcrServiceDeps,
  onProgress?: (current: number, total: number) => void,
  maxPages: number = DEFAULT_MAX_PAGES
): Promise<PdfPageContent[]> {
  // Render all pages to PNG images
  const allImages: PdfPageImage[] = await renderPdfPages(pdfData, onProgress);

  const truncated = allImages.length > maxPages;
  const images = truncated ? allImages.slice(0, maxPages) : allImages;

  const providerFamily = getProviderFamily(provider);
  const pages: PdfPageContent[] = [];

  for (const image of images) {
    const visionMessage = formatVisionMessage(
      image.base64Png,
      DEFAULT_OCR_PROMPT,
      providerFamily
    );

    // Build messages array — for Ollama, the images are on the message object directly
    const messages: unknown[] = [visionMessage];

    const extractedText = await deps.generateWithVision(messages, provider, model);

    pages.push({
      pageNumber: image.pageNumber,
      text: extractedText.trim(),
    });
  }

  if (truncated) {
    pages.push({
      pageNumber: maxPages + 1,
      text: `[Vision OCR truncated: processed ${maxPages} of ${allImages.length} pages. ` +
        `Re-run with a higher page limit or use text mode for the full document.]`,
    });
  }

  return pages;
}
