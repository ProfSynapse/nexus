/**
 * OcrService Unit Tests
 *
 * Tests the vision-based OCR orchestration loop: page rendering, provider family
 * resolution, vision message formatting, LLM calls, and text trimming.
 */

// Mock PdfPageRenderer
jest.mock(
  '../../src/agents/ingestManager/tools/services/PdfPageRenderer',
  () => ({
    renderPdfPages: jest.fn(),
  })
);

// Mock VisionMessageFormatter
jest.mock(
  '../../src/agents/ingestManager/tools/services/VisionMessageFormatter',
  () => ({
    formatVisionMessage: jest.fn(),
    getProviderFamily: jest.fn(),
  })
);

import {
  ocrPdf,
  OcrServiceDeps,
} from '../../src/agents/ingestManager/tools/services/OcrService';
import { renderPdfPages } from '../../src/agents/ingestManager/tools/services/PdfPageRenderer';
import {
  formatVisionMessage,
  getProviderFamily,
} from '../../src/agents/ingestManager/tools/services/VisionMessageFormatter';
import { PdfPageImage } from '../../src/agents/ingestManager/types';

const renderPdfPagesMock = renderPdfPages as jest.MockedFunction<typeof renderPdfPages>;
const formatVisionMessageMock = formatVisionMessage as jest.MockedFunction<typeof formatVisionMessage>;
const getProviderFamilyMock = getProviderFamily as jest.MockedFunction<typeof getProviderFamily>;

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePageImage(pageNumber: number): PdfPageImage {
  return {
    pageNumber,
    base64Png: `base64-page-${pageNumber}`,
    width: 800,
    height: 1200,
  };
}

function makeDeps(overrides: Partial<OcrServiceDeps> = {}): OcrServiceDeps {
  return {
    generateWithVision: jest.fn().mockResolvedValue('  Extracted text  '),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('OcrService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getProviderFamilyMock.mockReturnValue('openai');
    formatVisionMessageMock.mockReturnValue({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }],
    });
  });

  // ── Basic orchestration ───────────────────────────────────────────────

  describe('basic orchestration', () => {
    it('processes all pages and returns results in order', async () => {
      renderPdfPagesMock.mockResolvedValue([makePageImage(1), makePageImage(2), makePageImage(3)]);
      const deps = makeDeps({
        generateWithVision: jest.fn()
          .mockResolvedValueOnce('  Page 1 text  ')
          .mockResolvedValueOnce('Page 2 text')
          .mockResolvedValueOnce('  Page 3 text  '),
      });

      const result = await ocrPdf(new ArrayBuffer(100), 'openai', 'gpt-4o', deps);

      expect(result).toEqual([
        { pageNumber: 1, text: 'Page 1 text' },
        { pageNumber: 2, text: 'Page 2 text' },
        { pageNumber: 3, text: 'Page 3 text' },
      ]);
    });

    it('returns empty array for PDF with no pages', async () => {
      renderPdfPagesMock.mockResolvedValue([]);
      const deps = makeDeps();

      const result = await ocrPdf(new ArrayBuffer(100), 'openai', 'gpt-4o', deps);

      expect(result).toEqual([]);
      expect(deps.generateWithVision).not.toHaveBeenCalled();
    });

    it('handles single page PDF', async () => {
      renderPdfPagesMock.mockResolvedValue([makePageImage(1)]);
      const deps = makeDeps({ generateWithVision: jest.fn().mockResolvedValue('Single page') });

      const result = await ocrPdf(new ArrayBuffer(100), 'openai', 'gpt-4o', deps);

      expect(result).toEqual([{ pageNumber: 1, text: 'Single page' }]);
      expect(deps.generateWithVision).toHaveBeenCalledTimes(1);
    });
  });

  // ── Provider family resolution ────────────────────────────────────────

  describe('provider family resolution', () => {
    it('calls getProviderFamily with the provider string', async () => {
      renderPdfPagesMock.mockResolvedValue([makePageImage(1)]);
      const deps = makeDeps();

      await ocrPdf(new ArrayBuffer(100), 'anthropic', 'claude-3-opus', deps);

      expect(getProviderFamilyMock).toHaveBeenCalledWith('anthropic');
    });

    it('passes resolved family to formatVisionMessage', async () => {
      renderPdfPagesMock.mockResolvedValue([makePageImage(1)]);
      getProviderFamilyMock.mockReturnValue('anthropic');
      const deps = makeDeps();

      await ocrPdf(new ArrayBuffer(100), 'anthropic', 'claude-3-opus', deps);

      expect(formatVisionMessageMock).toHaveBeenCalledWith(
        'base64-page-1',
        expect.any(String),
        'anthropic'
      );
    });
  });

  // ── Vision message construction ───────────────────────────────────────

  describe('vision message construction', () => {
    it('passes page base64 and OCR prompt to formatVisionMessage', async () => {
      renderPdfPagesMock.mockResolvedValue([makePageImage(1)]);
      const deps = makeDeps();

      await ocrPdf(new ArrayBuffer(100), 'openai', 'gpt-4o', deps);

      expect(formatVisionMessageMock).toHaveBeenCalledWith(
        'base64-page-1',
        expect.stringContaining('Extract all text'),
        'openai'
      );
    });

    it('sends formatted message to generateWithVision with provider and model', async () => {
      renderPdfPagesMock.mockResolvedValue([makePageImage(1)]);
      const visionMsg = { role: 'user' as const, content: 'test-content' };
      formatVisionMessageMock.mockReturnValue(visionMsg);
      const deps = makeDeps();

      await ocrPdf(new ArrayBuffer(100), 'openai', 'gpt-4o', deps);

      expect(deps.generateWithVision).toHaveBeenCalledWith([visionMsg], 'openai', 'gpt-4o');
    });
  });

  // ── Text trimming ────────────────────────────────────────────────────

  describe('text trimming', () => {
    it('trims leading and trailing whitespace from extracted text', async () => {
      renderPdfPagesMock.mockResolvedValue([makePageImage(1)]);
      const deps = makeDeps({
        generateWithVision: jest.fn().mockResolvedValue('\n\n  Some text with spaces  \n\n'),
      });

      const result = await ocrPdf(new ArrayBuffer(100), 'openai', 'gpt-4o', deps);

      expect(result[0].text).toBe('Some text with spaces');
    });

    it('handles empty string from LLM', async () => {
      renderPdfPagesMock.mockResolvedValue([makePageImage(1)]);
      const deps = makeDeps({ generateWithVision: jest.fn().mockResolvedValue('   ') });

      const result = await ocrPdf(new ArrayBuffer(100), 'openai', 'gpt-4o', deps);

      expect(result[0].text).toBe('');
    });
  });

  // ── Progress callback ────────────────────────────────────────────────

  describe('progress callback', () => {
    it('passes onProgress to renderPdfPages', async () => {
      renderPdfPagesMock.mockResolvedValue([]);
      const deps = makeDeps();
      const onProgress = jest.fn();

      await ocrPdf(new ArrayBuffer(100), 'openai', 'gpt-4o', deps, onProgress);

      expect(renderPdfPagesMock).toHaveBeenCalledWith(expect.any(ArrayBuffer), onProgress);
    });

    it('works without onProgress callback', async () => {
      renderPdfPagesMock.mockResolvedValue([makePageImage(1)]);
      const deps = makeDeps();

      const result = await ocrPdf(new ArrayBuffer(100), 'openai', 'gpt-4o', deps);

      expect(result).toHaveLength(1);
      expect(renderPdfPagesMock).toHaveBeenCalledWith(expect.any(ArrayBuffer), undefined);
    });
  });

  // ── Error propagation ────────────────────────────────────────────────

  describe('error propagation', () => {
    it('propagates renderPdfPages errors', async () => {
      renderPdfPagesMock.mockRejectedValue(new Error('PDF render failed'));
      const deps = makeDeps();

      await expect(
        ocrPdf(new ArrayBuffer(100), 'openai', 'gpt-4o', deps)
      ).rejects.toThrow('PDF render failed');
    });

    it('propagates generateWithVision errors', async () => {
      renderPdfPagesMock.mockResolvedValue([makePageImage(1)]);
      const deps = makeDeps({
        generateWithVision: jest.fn().mockRejectedValue(new Error('LLM API timeout')),
      });

      await expect(
        ocrPdf(new ArrayBuffer(100), 'openai', 'gpt-4o', deps)
      ).rejects.toThrow('LLM API timeout');
    });

    it('fails on first page error without processing subsequent pages', async () => {
      renderPdfPagesMock.mockResolvedValue([makePageImage(1), makePageImage(2)]);
      const genMock = jest.fn().mockRejectedValueOnce(new Error('Page 1 failed'));
      const deps = makeDeps({ generateWithVision: genMock });

      await expect(
        ocrPdf(new ArrayBuffer(100), 'openai', 'gpt-4o', deps)
      ).rejects.toThrow('Page 1 failed');

      expect(genMock).toHaveBeenCalledTimes(1);
    });
  });
});
