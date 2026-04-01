/**
 * ListFormatsTool tests — validates the static format catalog.
 *
 * Covers: success result, all 3 formats present, platform availability,
 * audio-specific fields.
 */

import { ListFormatsTool } from '../../src/agents/apps/composer/tools/listFormats';
import { BaseAppAgent } from '../../src/agents/apps/BaseAppAgent';

function makeAgent(): BaseAppAgent {
  return {} as unknown as BaseAppAgent;
}

type FormatEntry = {
  format: string;
  platforms: string[];
  modes?: string[];
  outputFormats?: string[];
};

type ListFormatsResult = {
  success: boolean;
  data: {
    formats: FormatEntry[];
  };
};

describe('ListFormatsTool', () => {
  let tool: ListFormatsTool;

  beforeEach(() => {
    tool = new ListFormatsTool(makeAgent());
  });

  it('should return success', async () => {
    const result = await tool.execute({});
    expect(result.success).toBe(true);
  });

  it('should include markdown, pdf, and audio formats', async () => {
    const result = await tool.execute({}) as ListFormatsResult;
    const formatNames = result.data.formats.map((f: FormatEntry) => f.format);

    expect(formatNames).toContain('markdown');
    expect(formatNames).toContain('pdf');
    expect(formatNames).toContain('audio');
  });

  it('should list audio as desktop-only', async () => {
    const result = await tool.execute({}) as ListFormatsResult;
    const audio = result.data.formats.find((f: FormatEntry) => f.format === 'audio');

    expect(audio.platforms).toEqual(['desktop']);
    expect(audio.modes).toContain('concat');
    expect(audio.modes).toContain('mix');
  });

  it('should list markdown and pdf as cross-platform', async () => {
    const result = await tool.execute({}) as ListFormatsResult;
    const markdown = result.data.formats.find((f: FormatEntry) => f.format === 'markdown');
    const pdf = result.data.formats.find((f: FormatEntry) => f.format === 'pdf');

    expect(markdown.platforms).toContain('desktop');
    expect(markdown.platforms).toContain('mobile');
    expect(pdf.platforms).toContain('desktop');
    expect(pdf.platforms).toContain('mobile');
  });

  it('should include audio output formats', async () => {
    const result = await tool.execute({}) as ListFormatsResult;
    const audio = result.data.formats.find((f: FormatEntry) => f.format === 'audio');

    expect(audio.outputFormats).toEqual(['wav', 'mp3', 'webm']);
  });
});
