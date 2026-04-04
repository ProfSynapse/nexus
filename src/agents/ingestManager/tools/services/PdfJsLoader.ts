/**
 * Location: src/agents/ingestManager/tools/services/PdfJsLoader.ts
 * Purpose: Load PDF.js in a way that works inside the Obsidian/Electron renderer.
 *
 * PDF.js 5 treats the renderer as a browser and expects a configured workerSrc
 * unless a main-thread worker handler is already registered on globalThis.
 * We seed that handler explicitly from the bundled worker module so ingestion
 * can run without a separate worker asset URL.
 */

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type PdfJsWorkerModule = typeof import('pdfjs-dist/legacy/build/pdf.worker.mjs');

declare global {
  interface Window {
    pdfjsWorker?: PdfJsWorkerModule;
  }

  // eslint-disable-next-line no-var
  var pdfjsWorker: PdfJsWorkerModule | undefined;
}

let pdfJsModulePromise: Promise<PdfJsModule> | null = null;

export async function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = initializePdfJs();
  }
  return pdfJsModulePromise;
}

async function initializePdfJs(): Promise<PdfJsModule> {
  const [pdfjsLib, pdfjsWorker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
  ]);

  if (!globalThis.pdfjsWorker) {
    globalThis.pdfjsWorker = pdfjsWorker;
  }

  return pdfjsLib;
}
