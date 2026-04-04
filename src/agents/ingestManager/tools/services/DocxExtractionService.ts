/**
 * Location: src/agents/ingestManager/tools/services/DocxExtractionService.ts
 * Purpose: Extract Markdown content from DOCX files using Mammoth.
 *
 * Used by: IngestionPipelineService
 * Dependencies: mammoth
 */

import mammoth from 'mammoth';
import { DocxExtractionResult } from '../../types';

interface MammothMarkdownMessage {
  type: string;
  message: string;
}

interface MammothMarkdownResult {
  value: string;
  messages: MammothMarkdownMessage[];
}

type MammothWithMarkdown = typeof mammoth & {
  convertToMarkdown: (input: { buffer: Buffer }) => Promise<MammothMarkdownResult>;
};

/**
 * Convert a DOCX file into Markdown.
 */
export async function extractDocxMarkdown(docxData: ArrayBuffer): Promise<DocxExtractionResult> {
  const mammothWithMarkdown = mammoth as MammothWithMarkdown;
  const result = await mammothWithMarkdown.convertToMarkdown({
    buffer: Buffer.from(new Uint8Array(docxData))
  });

  return {
    markdown: result.value.trim(),
    warnings: result.messages.map(message => `${message.type}: ${message.message}`)
  };
}
