/**
 * ListFormatsTool — Static catalog of supported composition formats.
 *
 * Located at: src/agents/apps/composer/tools/listFormats.ts
 * Returns supported formats, their file extensions, platform availability,
 * and composition modes. Helps LLMs discover capabilities before composing.
 *
 * Used by: ComposerAgent, exposed via MCP getTools/useTools.
 */

import { BaseTool } from '../../../baseTool';
import { BaseAppAgent } from '../../BaseAppAgent';
import { CommonParameters, CommonResult } from '../../../../types';
import { JSONSchema } from '../../../../types/schema/JSONSchemaTypes';
import type { ToolStatusTense } from '../../../interfaces/ITool';
import { verbs } from '../../../utils/toolStatusLabels';

export class ListFormatsTool extends BaseTool<CommonParameters, CommonResult> {
  constructor(_agent: BaseAppAgent) {
    super(
      'listFormats',
      'List Formats',
      'List supported composition formats, their file extensions, and platform availability.',
      '1.0.0'
    );
  }

  getStatusLabel(_params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    const v = verbs('Listing formats', 'Listed formats', 'Failed to list formats');
    return v[tense];
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- implements abstract BaseTool.execute()
  async execute(_params: CommonParameters): Promise<CommonResult> {
    return this.prepareResult(true, {
      formats: [
        {
          format: 'markdown',
          extensions: ['md', 'txt', 'markdown'],
          platforms: ['desktop', 'mobile'],
          modes: ['concat'],
          description: 'Concatenate text files with separators, headers, and frontmatter handling',
        },
        {
          format: 'pdf',
          extensions: ['pdf'],
          platforms: ['desktop', 'mobile'],
          modes: ['concat'],
          description: 'Merge PDF files — all pages from each file are appended sequentially',
        },
        {
          format: 'audio',
          extensions: ['mp3', 'wav', 'ogg', 'webm', 'aac', 'm4a', 'flac'],
          platforms: ['desktop'],
          modes: ['concat', 'mix'],
          outputFormats: ['wav', 'mp3', 'webm'],
          description: 'Compose audio — concat (sequential) or mix (layered tracks with volume/offset/fade). WebM encoding runs at real-time speed.',
        },
      ],
    });
  }

  getParameterSchema(): JSONSchema {
    return this.getMergedSchema({
      type: 'object',
      properties: {},
    });
  }
}
