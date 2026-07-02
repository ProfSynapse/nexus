/**
 * Location: src/agents/ingestManager/tools/services/OcrService.ts
 * Purpose: OCR service for PDF vision mode. Renders PDF pages to images,
 * formats them for the target provider's vision API, and extracts text via LLM.
 *
 * Used by: IngestionPipelineService (vision mode)
 * Dependencies: PdfPageRenderer, VisionMessageFormatter, LLM adapters
 */

import { PdfPageContent, PdfPageImage, OcrExtractedImage, OcrResult } from '../../types';
import { requestUrl } from 'obsidian';
import { renderPdfPages } from './PdfPageRenderer';
import { formatVisionMessage, getProviderFamily } from './VisionMessageFormatter';

const DEFAULT_OCR_PROMPT =
  'Extract all text from this PDF page image. Preserve the original formatting, headings, and structure as closely as possible. Return only the extracted text, no commentary.';
// The file-parser plugin runs Mistral OCR on the PDF regardless of the model or
// prompt; the raw OCR result is returned in message.annotations, NOT in the
// model's completion. We only need a carrier model to trigger the parse, so use
// a cheap/stable one and cap the (discarded) completion.
const OPENROUTER_PDF_OCR_PROMPT = 'Reply with "ok".';
const OPENROUTER_DEFAULT_PDF_MODEL = 'google/gemini-2.5-flash-lite';

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
): Promise<OcrResult> {
  if (provider === 'mistral' && model === 'mistral-ocr') {
    return ocrPdfWithMistral(pdfData, deps);
  }

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

  // Generic vision OCR reproduces text only; it does not emit embedded image assets.
  return { pages, images: [] };
}

async function ocrPdfWithOpenRouter(
  pdfData: ArrayBuffer,
  deps: OcrServiceDeps
): Promise<OcrResult> {
  const apiKey = deps.getApiKey?.('openrouter');
  if (!apiKey) {
    throw new Error('No API key configured for provider "openrouter"');
  }

  const { httpReferer, xTitle } = deps.getOpenRouterHeaders?.() || {};
  const fileData = `data:application/pdf;base64,${arrayBufferToBase64(pdfData)}`;

  const response = await requestUrl({
    url: 'https://openrouter.ai/api/v1/chat/completions',
    method: 'POST',
    // Don't throw on non-2xx — OpenRouter returns the parsed OCR annotations in
    // error.metadata.file_annotations even when the carrier model errors.
    throw: false,
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
      temperature: 0,
      // The completion is discarded — we only read the OCR annotations.
      max_tokens: 16
    })
  });

  // Primary source of truth: the raw Mistral-OCR output lives in the file
  // annotations, NOT in the model's completion (message.content is the model's
  // own paraphrase of the OCR and is truncated/rewritten).
  const { text, imageDataUrls } = extractOcrFromAnnotations(response.json);
  const ocrText = text.trim();

  if (ocrText) {
    // Embedded images have no id in the response — correlate positionally: the
    // k-th image_url part maps to the k-th `![alt](target)` ref in reading order.
    const refTargets = parseImageRefTargets(ocrText);
    const images: OcrExtractedImage[] = imageDataUrls.map((dataUrl, i) => ({
      pageNumber: 1,
      refId: refTargets[i] ?? `ocr-image-${i}`,
      dataUrl,
    }));
    return { pages: [{ pageNumber: 1, text: ocrText }], images };
  }

  // No annotations returned — surface a real error rather than silently
  // handing back the carrier model's rewritten guess.
  if (response.status !== 200) {
    const message = extractOpenRouterErrorMessage(response.json);
    throw new Error(
      `OpenRouter Mistral OCR failed: HTTP ${response.status}${message ? ` — ${message}` : ''}`
    );
  }

  throw new Error(
    'OpenRouter Mistral OCR returned no parsed content. ' +
    'The file-parser annotations were empty — the PDF may be unsupported or the ' +
    'mistral-ocr engine may be unavailable for this account.'
  );
}

/**
 * Process a PDF through Mistral's native OCR API (https://api.mistral.ai/v1/ocr).
 * Unlike the OpenRouter path, this hits Mistral directly — no carrier LLM — and
 * returns per-page markdown plus images with explicit ids that match the
 * `![id](id)` refs in the markdown (so correlation is exact, not positional).
 */
async function ocrPdfWithMistral(
  pdfData: ArrayBuffer,
  deps: OcrServiceDeps
): Promise<OcrResult> {
  const apiKey = deps.getApiKey?.('mistral');
  if (!apiKey) {
    throw new Error('No API key configured for provider "mistral"');
  }

  const documentUrl = `data:application/pdf;base64,${arrayBufferToBase64(pdfData)}`;

  const response = await requestUrl({
    url: 'https://api.mistral.ai/v1/ocr',
    method: 'POST',
    throw: false,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'mistral-ocr-latest',
      document: { type: 'document_url', document_url: documentUrl },
      include_image_base64: true,
    }),
  });

  if (response.status !== 200) {
    const message = extractMistralErrorMessage(response.json);
    throw new Error(
      `Mistral OCR failed: HTTP ${response.status}${message ? ` — ${message}` : ''}`
    );
  }

  const apiPages = Array.isArray((response.json as { pages?: unknown })?.pages)
    ? (response.json as { pages: unknown[] }).pages
    : [];

  const pages: PdfPageContent[] = [];
  const images: OcrExtractedImage[] = [];

  apiPages.forEach((rawPage, i) => {
    const page = rawPage as {
      index?: unknown;
      markdown?: unknown;
      images?: Array<{ id?: unknown; image_base64?: unknown }>;
    };
    const pageNumber = typeof page.index === 'number' ? page.index + 1 : i + 1;
    const markdown = typeof page.markdown === 'string' ? page.markdown : '';

    pages.push({ pageNumber, text: markdown.trim() });

    for (const rawImage of Array.isArray(page.images) ? page.images : []) {
      const id = rawImage?.id;
      const dataUrl = rawImage?.image_base64;
      if (typeof id === 'string' && typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
        images.push({ pageNumber, refId: id, dataUrl });
      }
    }
  });

  if (pages.length === 0) {
    throw new Error('Mistral OCR returned no pages.');
  }

  return { pages, images };
}

function extractMistralErrorMessage(data: unknown): string {
  const d = data as { message?: unknown; error?: { message?: unknown }; detail?: unknown };
  if (typeof d?.message === 'string') return d.message;
  if (typeof d?.error?.message === 'string') return d.error.message;
  if (typeof d?.detail === 'string') return d.detail;
  return '';
}

/**
 * Extract raw OCR text and embedded image data URLs from OpenRouter file-parser
 * annotations. The parsed content is attached to the assistant message (on
 * success) or to error.metadata.file_annotations (on failure), as an ordered
 * array of content parts. Text parts are concatenated; image_url parts are
 * collected in document order (their position is the only correlation to the
 * `![alt](img-N)` refs in the markdown, since image parts carry no id).
 */
function extractOcrFromAnnotations(data: unknown): { text: string; imageDataUrls: string[] } {
  const root = data as {
    choices?: Array<{ message?: { annotations?: unknown[] } }>;
    error?: { metadata?: { file_annotations?: unknown[] } };
  };

  const fromMessage = root?.choices?.[0]?.message?.annotations ?? [];
  const fromError = root?.error?.metadata?.file_annotations ?? [];

  const texts: string[] = [];
  const imageDataUrls: string[] = [];
  const seenHashes = new Set<string>();

  for (const annotation of [...fromMessage, ...fromError]) {
    if (!annotation || typeof annotation !== 'object') continue;
    const a = annotation as { type?: unknown; file?: { hash?: unknown; content?: unknown } };
    if (a.type !== 'file' || !a.file) continue;

    // Deduplicate — the same file annotation can appear in both places.
    const hash = typeof a.file.hash === 'string' ? a.file.hash : '';
    if (hash && seenHashes.has(hash)) continue;
    if (hash) seenHashes.add(hash);

    const parts = Array.isArray(a.file.content) ? a.file.content : [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const type = (part as { type?: unknown }).type;
      if (type === 'text') {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') texts.push(stripFileWrapper(text));
      } else if (type === 'image_url') {
        const url = (part as { image_url?: { url?: unknown } }).image_url?.url;
        if (typeof url === 'string' && url.startsWith('data:')) imageDataUrls.push(url);
      }
    }
  }

  return { text: texts.join('\n\n'), imageDataUrls };
}

/**
 * Parse markdown image link targets (`![alt](target)`) in document order.
 * Used to positionally correlate ordered image_url parts to their refs.
 */
function parseImageRefTargets(markdown: string): string[] {
  const targets: string[] = [];
  const re = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    targets.push(match[1]);
  }
  return targets;
}

/**
 * OpenRouter wraps the parsed OCR markdown in `<file name="...">...</file>`
 * tags. Strip that wrapper so it doesn't leak into the output note.
 */
function stripFileWrapper(text: string): string {
  return text
    .replace(/^\s*<file\b[^>]*>\s*/i, '')
    .replace(/\s*<\/file>\s*$/i, '')
    .trim();
}

function extractOpenRouterErrorMessage(data: unknown): string {
  const message = (data as { error?: { message?: unknown } })?.error?.message;
  return typeof message === 'string' ? message : '';
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
