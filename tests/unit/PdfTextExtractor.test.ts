/**
 * PdfTextExtractor Unit Tests
 *
 * Tests PDF text extraction with a mocked pdfjs-dist module.
 * Verifies text concatenation across pages, hasEOL handling,
 * and whitespace trimming.
 */

// Mock the PDF.js loader before importing the module under test
jest.mock('../../src/agents/ingestManager/tools/services/PdfJsLoader', () => ({
  loadPdfJs: jest.fn(),
}));

import { extractPdfText } from '../../src/agents/ingestManager/tools/services/PdfTextExtractor';
import { loadPdfJs } from '../../src/agents/ingestManager/tools/services/PdfJsLoader';

const loadPdfJsMock = loadPdfJs as jest.MockedFunction<typeof loadPdfJs>;
const getDocumentMock = jest.fn();

/**
 * Helper to build a mock PDF document with specified page text items.
 * Each page is an array of text items: { str, hasEOL? }
 */
function mockPdfDocument(pages: Array<Array<{ str: string; hasEOL?: boolean }>>) {
  const pageObjects = pages.map((items) => ({
    getTextContent: jest.fn().mockResolvedValue({
      items: items.map((item) => ({
        str: item.str,
        hasEOL: item.hasEOL ?? false,
      })),
    }),
  }));

  const pdfDoc = {
    numPages: pages.length,
    getPage: jest.fn((pageNum: number) => Promise.resolve(pageObjects[pageNum - 1])),
  };

  getDocumentMock.mockReturnValue({
    promise: Promise.resolve(pdfDoc),
  });

  return { pdfDoc, pageObjects };
}

describe('PdfTextExtractor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    loadPdfJsMock.mockResolvedValue({
      getDocument: getDocumentMock,
    } as unknown as Awaited<ReturnType<typeof loadPdfJs>>);
  });

  // ==========================================================================
  // Basic extraction
  // ==========================================================================

  describe('basic extraction', () => {
    it('should extract text from a single-page PDF', async () => {
      mockPdfDocument([
        [{ str: 'Hello World' }],
      ]);

      const pages = await extractPdfText(new ArrayBuffer(8));

      expect(pages).toHaveLength(1);
      expect(pages[0].pageNumber).toBe(1);
      expect(pages[0].text).toBe('Hello World');
    });

    it('should extract text from a multi-page PDF', async () => {
      mockPdfDocument([
        [{ str: 'Page one content' }],
        [{ str: 'Page two content' }],
        [{ str: 'Page three content' }],
      ]);

      const pages = await extractPdfText(new ArrayBuffer(8));

      expect(pages).toHaveLength(3);
      expect(pages[0].text).toBe('Page one content');
      expect(pages[1].text).toBe('Page two content');
      expect(pages[2].text).toBe('Page three content');
    });

    it('should set correct page numbers', async () => {
      mockPdfDocument([
        [{ str: 'A' }],
        [{ str: 'B' }],
      ]);

      const pages = await extractPdfText(new ArrayBuffer(8));
      expect(pages[0].pageNumber).toBe(1);
      expect(pages[1].pageNumber).toBe(2);
    });
  });

  // ==========================================================================
  // Text concatenation and hasEOL handling
  // ==========================================================================

  describe('text concatenation', () => {
    it('should concatenate multiple text items on a page', async () => {
      mockPdfDocument([
        [
          { str: 'Hello ' },
          { str: 'World' },
        ],
      ]);

      const pages = await extractPdfText(new ArrayBuffer(8));
      expect(pages[0].text).toBe('Hello World');
    });

    it('should add newline when hasEOL is true', async () => {
      mockPdfDocument([
        [
          { str: 'Line one', hasEOL: true },
          { str: 'Line two' },
        ],
      ]);

      const pages = await extractPdfText(new ArrayBuffer(8));
      expect(pages[0].text).toBe('Line one\nLine two');
    });

    it('should handle multiple lines with hasEOL', async () => {
      mockPdfDocument([
        [
          { str: 'First', hasEOL: true },
          { str: 'Second', hasEOL: true },
          { str: 'Third' },
        ],
      ]);

      const pages = await extractPdfText(new ArrayBuffer(8));
      expect(pages[0].text).toBe('First\nSecond\nThird');
    });

    it('should not add newline when hasEOL is false', async () => {
      mockPdfDocument([
        [
          { str: 'No ', hasEOL: false },
          { str: 'break' },
        ],
      ]);

      const pages = await extractPdfText(new ArrayBuffer(8));
      expect(pages[0].text).toBe('No break');
    });
  });

  // ==========================================================================
  // Trimming
  // ==========================================================================

  describe('trimming', () => {
    it('should trim leading and trailing whitespace from page text', async () => {
      mockPdfDocument([
        [
          { str: '  Padded text  ' },
        ],
      ]);

      const pages = await extractPdfText(new ArrayBuffer(8));
      expect(pages[0].text).toBe('Padded text');
    });

    it('should trim trailing newlines from hasEOL', async () => {
      mockPdfDocument([
        [
          { str: 'Content', hasEOL: true },
        ],
      ]);

      const pages = await extractPdfText(new ArrayBuffer(8));
      expect(pages[0].text).toBe('Content');
    });
  });

  // ==========================================================================
  // Edge cases
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle empty page (no text items)', async () => {
      mockPdfDocument([[]]);

      const pages = await extractPdfText(new ArrayBuffer(8));
      expect(pages).toHaveLength(1);
      expect(pages[0].text).toBe('');
    });

    it('should handle items without str property (skip non-text items)', async () => {
      const mockPage = {
        getTextContent: jest.fn().mockResolvedValue({
          items: [
            { str: 'Text item' },
            { width: 100, height: 50 }, // Non-text item (no str)
            { str: ' more text' },
          ],
        }),
      };

      const pdfDoc = {
        numPages: 1,
        getPage: jest.fn().mockResolvedValue(mockPage),
      };

      getDocumentMock.mockReturnValue({
        promise: Promise.resolve(pdfDoc),
      });

      const pages = await extractPdfText(new ArrayBuffer(8));
      expect(pages[0].text).toBe('Text item more text');
    });

    it('should pass Uint8Array to getDocument', async () => {
      mockPdfDocument([[{ str: 'Test' }]]);

      const buffer = new ArrayBuffer(16);
      await extractPdfText(buffer);

      expect(getDocumentMock).toHaveBeenCalledWith({
        data: expect.any(Uint8Array),
      });
    });
  });
});
