/**
 * Location: src/agents/ingestManager/tools/services/OcrService.ts
 * Purpose: OCR service for PDF vision mode. Renders PDF pages to images,
 * formats them for the target provider's vision API, and extracts text via LLM.
 *
 * Used by: IngestionPipelineService (vision mode)
 * Dependencies: PdfPageRenderer, VisionMessageFormatter, LLM adapters
 */

import { PdfPageContent, PdfPageImage } from '../../types';
import { requestUrl } from 'obsidian';
import { renderPdfPages } from './PdfPageRenderer';
import { formatVisionMessage, getProviderFamily } from './VisionMessageFormatter';

const DEFAULT_OCR_PROMPT =
  'Extract all text from this PDF page image. Preserve the original formatting, headings, and structure as closely as possible. Return only the extracted text, no commentary.';
const OPENROUTER_PDF_OCR_PROMPT =
  'Extract all text from this PDF. Preserve the original formatting, headings, tables, and structure as closely as possible. Return only the extracted text.';
const OPENROUTER_DEFAULT_PDF_MODEL = 'openrouter/auto';

export interface OcrServiceDeps {
  /** Call the LLM adapter's generate method with a vision message */
  generateWithVision: (
    messages: unknown[],
    provider: string,
    model: string
  ) => Promise<string>;
  /** Get API key for provider-specific OCR endpoints */
  getApiKey?: (provider: string) => string | undefined;
  /** OpenRouter attribution headers */
  getOpenRouterHeaders?: () => { httpReferer?: string; xTitle?: string };
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
  if (provider === 'openrouter' && model === 'mistral-ocr') {
    return ocrPdfWithOpenRouter(pdfData, deps);
  }

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

async function ocrPdfWithOpenRouter(
  pdfData: ArrayBuffer,
  deps: OcrServiceDeps
): Promise<PdfPageContent[]> {
  const apiKey = deps.getApiKey?.('openrouter');
  if (!apiKey) {
    throw new Error('No API key configured for provider "openrouter"');
  }

  const { httpReferer, xTitle } = deps.getOpenRouterHeaders?.() || {};
  const fileData = `data:application/pdf;base64,${arrayBufferToBase64(pdfData)}`;

  const response = await requestUrl({
    url: 'https://openrouter.ai/api/v1/chat/completions',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(httpReferer ? { 'HTTP-Referer': httpReferer } : {}),
      ...(xTitle ? { 'X-Title': xTitle } : {})
    },
    body: JSON.stringify({
      model: OPENROUTER_DEFAULT_PDF_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: OPENROUTER_PDF_OCR_PROMPT
            },
            {
              type: 'file',
              file: {
                filename: 'document.pdf',
                file_data: fileData
              }
            }
          ]
        }
      ],
      plugins: [
        {
          id: 'file-parser',
          pdf: {
            engine: 'mistral-ocr'
          }
        }
      ],
      stream: false,
      temperature: 0
    })
  });

  if (response.status !== 200) {
    throw new Error(`OpenRouter PDF OCR failed: HTTP ${response.status}`);
  }

  const content = extractOpenRouterContent(response.json);
  return [{
    pageNumber: 1,
    text: content.trim()
  }];
}

function extractOpenRouterContent(data: unknown): string {
  const choices = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
  const content = choices?.[0]?.message?.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') {
          return part;
        }

        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }

        return '';
      })
      .join('\n');
  }

  return '';
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
