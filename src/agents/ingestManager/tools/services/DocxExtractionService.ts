/**
 * Location: src/agents/ingestManager/tools/services/DocxExtractionService.ts
 * Purpose: Extract Markdown content from DOCX files using Mammoth.
 *
 * Used by: IngestionPipelineService
 * Dependencies: mammoth
 */

import { DocxExtractionResult } from '../../types';

interface MammothMarkdownMessage {
  type: string;
  message: string;
}

interface MammothMarkdownResult {
  value: string;
  messages: MammothMarkdownMessage[];
}

interface MammothWithMarkdown {
  convertToMarkdown: (input: { buffer: Buffer }) => Promise<MammothMarkdownResult>;
}

/**
 * Convert a DOCX file into Markdown.
 */
export async function extractDocxMarkdown(docxData: ArrayBuffer): Promise<DocxExtractionResult> {
  const mammothModule = await import('mammoth');
  const mammothWithMarkdown = mammothModule.default as unknown as MammothWithMarkdown;
  const result = await mammothWithMarkdown.convertToMarkdown({
    buffer: Buffer.from(new Uint8Array(docxData))
  });

  return {
    markdown: result.value.trim(),
    warnings: result.messages.map(message => `${message.type}: ${message.message}`)
  };
}
