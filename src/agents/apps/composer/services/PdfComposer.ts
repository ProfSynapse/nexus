/**
 * PdfComposer — PDF file merging via pdf-lib.
 *
 * Located at: src/agents/apps/composer/services/PdfComposer.ts
 * Merges multiple PDF files by copying all pages from each source into
 * a single output document. Pure JavaScript, cross-platform (desktop + mobile).
 * Implements IFormatComposer.
 *
 * Used by: compose.ts tool when format='pdf'.
 */

import { Vault } from 'obsidian';
// pdf-lib is loaded lazily inside compose(). This module IS statically
// reachable from src/main.ts (SettingsTabManager -> SettingsView -> DefaultsTab
// -> AppManager -> ComposerAgent -> compose.ts), so a top-level `import
// { PDFDocument } from 'pdf-lib'` would evaluate the whole of pdf-lib during
// plugin init on every device, phones included. `import type` is erased at
// compile time and costs nothing at runtime — keep it that way.
import type { PDFDocument as PDFDocumentType } from 'pdf-lib';
import { IFormatComposer, ComposeInput, ComposeOptions, ComposerError } from '../types';

/** Memoized pdf-lib module load, so repeated composes pay the cost once. */
let pdfLibPromise: Promise<typeof import('pdf-lib')> | null = null;

function loadPdfLib(): Promise<typeof import('pdf-lib')> {
  if (!pdfLibPromise) {
    pdfLibPromise = import('pdf-lib');
  }
  return pdfLibPromise;
}

export class PdfComposer implements IFormatComposer {
  readonly supportedExtensions = ['pdf'];
  readonly isAvailableOnPlatform = true;

  async compose(
    input: ComposeInput,
    vault: Vault,
    _options: ComposeOptions
  ): Promise<Uint8Array> {
    if (input.mode !== 'concat') {
      throw new ComposerError('PDF composition only supports concat mode');
    }

    const { PDFDocument } = await loadPdfLib();

    const files = input.files;
    const outputPdf = await PDFDocument.create();

    for (const file of files) {
      const arrayBuffer = await vault.readBinary(file);
      let sourcePdf: PDFDocumentType;

      try {
        // ignoreEncryption: true handles PDFs with DRM restriction flags
        // but no actual password (common for copy-protected PDFs)
        sourcePdf = await PDFDocument.load(arrayBuffer, {
          ignoreEncryption: true,
        });
      } catch {
        throw new ComposerError(
          `Failed to parse PDF: ${file.path} — file may be corrupted or use unsupported features`,
          [file.path]
        );
      }

      const pageIndices = sourcePdf.getPageIndices();
      const copiedPages = await outputPdf.copyPages(sourcePdf, pageIndices);

      for (const page of copiedPages) {
        outputPdf.addPage(page);
      }
    }

    const outputBytes = await outputPdf.save();
    return outputBytes;
  }
}
