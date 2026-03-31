/**
 * DocxExtractionService Unit Tests
 */

jest.mock('mammoth', () => ({
  convertToMarkdown: jest.fn(),
}));

import mammoth from 'mammoth';
import { extractDocxMarkdown } from '../../src/agents/ingestManager/tools/services/DocxExtractionService';

const convertToMarkdownMock = (mammoth as unknown as {
  convertToMarkdown: jest.Mock;
}).convertToMarkdown;

describe('DocxExtractionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes a Buffer to mammoth and trims markdown output', async () => {
    convertToMarkdownMock.mockResolvedValue({
      value: '# Title\n\nBody text\n',
      messages: []
    });

    const result = await extractDocxMarkdown(new Uint8Array([1, 2, 3]).buffer);

    expect(convertToMarkdownMock).toHaveBeenCalledTimes(1);
    const [input] = convertToMarkdownMock.mock.calls[0];
    expect(Buffer.isBuffer(input.buffer)).toBe(true);
    expect(result).toEqual({
      markdown: '# Title\n\nBody text',
      warnings: []
    });
  });

  it('maps mammoth messages into warnings', async () => {
    convertToMarkdownMock.mockResolvedValue({
      value: 'Text',
      messages: [{ type: 'warning', message: 'Something odd happened' }]
    });

    const result = await extractDocxMarkdown(new Uint8Array([4, 5, 6]).buffer);

    expect(result.warnings).toEqual(['warning: Something odd happened']);
  });
});
