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
    const result = await tool.execute({});
    const data = (result as any).data;
    const formatNames = data.formats.map((f: any) => f.format);

    expect(formatNames).toContain('markdown');
    expect(formatNames).toContain('pdf');
    expect(formatNames).toContain('audio');
  });

  it('should list audio as desktop-only', async () => {
    const result = await tool.execute({});
    const data = (result as any).data;
    const audio = data.formats.find((f: any) => f.format === 'audio');

    expect(audio.platforms).toEqual(['desktop']);
    expect(audio.modes).toContain('concat');
    expect(audio.modes).toContain('mix');
  });

  it('should list markdown and pdf as cross-platform', async () => {
    const result = await tool.execute({});
    const data = (result as any).data;
    const markdown = data.formats.find((f: any) => f.format === 'markdown');
    const pdf = data.formats.find((f: any) => f.format === 'pdf');

    expect(markdown.platforms).toContain('desktop');
    expect(markdown.platforms).toContain('mobile');
    expect(pdf.platforms).toContain('desktop');
    expect(pdf.platforms).toContain('mobile');
  });

  it('should include audio output formats', async () => {
    const result = await tool.execute({});
    const data = (result as any).data;
    const audio = data.formats.find((f: any) => f.format === 'audio');

    expect(audio.outputFormats).toEqual(['wav', 'mp3', 'webm']);
  });
});
