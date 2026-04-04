/**
 * Location: src/agents/ingestManager/tools/services/PdfPageRenderer.ts
 * Purpose: Render PDF pages to PNG base64 images for vision-based OCR.
 * Uses pdfjs-dist page rendering via OffscreenCanvas (Electron desktop only).
 *
 * Used by: OcrService (vision mode)
 * Dependencies: pdfjs-dist legacy build
 */

import { PdfPageImage } from '../../types';
import { loadPdfJs } from './PdfJsLoader';

const RENDER_SCALE = 2.0; // 2x for good OCR quality

/**
 * Render all pages of a PDF to base64 PNG images.
 * Requires desktop (OffscreenCanvas). Each page is rendered then immediately
 * converted to PNG to avoid holding large canvas objects in memory.
 */
export async function renderPdfPages(
  pdfData: ArrayBuffer,
  onProgress?: (current: number, total: number) => void
): Promise<PdfPageImage[]> {
  const pdfjsLib = await loadPdfJs();

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfData),
  });

  const pdf = await loadingTask.promise;
  const pageCount = pdf.numPages;
  const images: PdfPageImage[] = [];

  for (let i = 1; i <= pageCount; i++) {
    onProgress?.(i, pageCount);

    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: RENDER_SCALE });

    const width = Math.floor(viewport.width);
    const height = Math.floor(viewport.height);

    // Use OffscreenCanvas for rendering (available in Electron)
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
    if (!ctx) {
      throw new Error(`Failed to get 2D context for page ${i}`);
    }

    // pdfjs-dist v5 requires canvas property; pass null since we use OffscreenCanvas
    // canvasContext is the actual rendering target, canvas is for dimension reference
    await page.render({
      canvas: null,
      canvasContext: ctx,
      viewport,
    }).promise;

    // Convert to PNG blob then to base64
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const base64Png = await blobToBase64(blob);

    images.push({
      pageNumber: i,
      base64Png,
      width,
      height,
    });
  }

  return images;
}

/**
 * Convert a Blob to a base64 string (without the data: prefix).
 */
async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
