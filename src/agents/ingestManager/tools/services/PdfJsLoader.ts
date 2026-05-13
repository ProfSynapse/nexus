/**
 * Location: src/agents/ingestManager/tools/services/PdfJsLoader.ts
 * Purpose: Load PDF.js in a way that works inside the Obsidian/Electron renderer.
 *
 * PDF.js 5 treats the renderer as a browser and expects a configured workerSrc.
 * Obsidian community releases can only ship main.js/manifest.json/styles.css,
 * so the worker must not be bundled into main.js or emitted as a separate
 * release asset. Configure PDF.js to load its worker lazily when PDF ingestion
 * is actually used.
 */

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

export async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = initializePdfJs();
  }
  return pdfJsModulePromise;
}

async function initializePdfJs(): Promise<PdfJsModule> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/legacy/build/pdf.worker.mjs`;
  }

  return pdfjsLib;
}
