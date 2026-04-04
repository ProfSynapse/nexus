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
import { PDFDocument } from 'pdf-lib';
import { IFormatComposer, ComposeInput, ComposeOptions, ComposerError } from '../types';

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

    const files = input.files;
    const outputPdf = await PDFDocument.create();

    for (const file of files) {
      const arrayBuffer = await vault.readBinary(file);
      let sourcePdf: PDFDocument;

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
