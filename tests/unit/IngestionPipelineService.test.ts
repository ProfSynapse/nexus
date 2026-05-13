/**
 * IngestionPipelineService Unit Tests
 *
 * Integration-style unit tests that mock the downstream services
 * (OcrService, PdfTextExtractor, TranscriptionService) and verify
 * pipeline routing, output path construction, and progress callbacks.
 */

// Mock PdfTextExtractor
jest.mock(
  '../../src/agents/ingestManager/tools/services/PdfTextExtractor',
  () => ({
    extractPdfText: jest.fn(),
  })
);

// Mock DocxExtractionService
jest.mock(
  '../../src/agents/ingestManager/tools/services/DocxExtractionService',
  () => ({
    extractDocxMarkdown: jest.fn(),
  })
);

jest.mock(
  '../../src/agents/ingestManager/tools/services/PptxExtractionService',
  () => ({
    extractPptxContent: jest.fn(),
  })
);

// Mock OcrService
jest.mock(
  '../../src/agents/ingestManager/tools/services/OcrService',
  () => ({
    ocrPdf: jest.fn(),
  })
);

import { processFile } from '../../src/agents/ingestManager/tools/services/IngestionPipelineService';
import { extractDocxMarkdown } from '../../src/agents/ingestManager/tools/services/DocxExtractionService';
import { extractPdfText } from '../../src/agents/ingestManager/tools/services/PdfTextExtractor';
import { extractPptxContent } from '../../src/agents/ingestManager/tools/services/PptxExtractionService';
import { ocrPdf } from '../../src/agents/ingestManager/tools/services/OcrService';
import {
  IngestFileRequest,
  IngestProgress,
  PdfPageContent,
  TranscriptionSegment,
} from '../../src/agents/ingestManager/types';
import { TFile, Vault } from 'obsidian';

const extractDocxMarkdownMock = extractDocxMarkdown as jest.MockedFunction<typeof extractDocxMarkdown>;
const extractPdfTextMock = extractPdfText as jest.MockedFunction<typeof extractPdfText>;
const extractPptxContentMock = extractPptxContent as jest.MockedFunction<typeof extractPptxContent>;
const ocrPdfMock = ocrPdf as jest.MockedFunction<typeof ocrPdf>;

/** Create a mock Vault with configurable getFileByPath, readBinary, create, modify */
function createMockVault(options: {
  fileExists?: boolean;
  existingOutput?: boolean;
} = {}) {
  const { fileExists = true, existingOutput = false } = options;

  const mockFile = fileExists ? new TFile('report.pdf', 'notes/report.pdf') : null;
  const outputFile = existingOutput ? new TFile('report.md', 'notes/report.md') : null;

  return {
    getFileByPath: jest.fn((path: string) => {
      if (path === 'notes/report.pdf' && mockFile) return mockFile;
      if (path === 'notes/report.md' && outputFile) return outputFile;
      if (path === 'notes/proposal.docx') return new TFile('proposal.docx', 'notes/proposal.docx');
      if (path === 'notes/deck.pptx') return new TFile('deck.pptx', 'notes/deck.pptx');
      if (path === 'notes/finance.xlsx') return new TFile('finance.xlsx', 'notes/finance.xlsx');
      if (path === 'notes/recording.mp3') return new TFile('recording.mp3', 'notes/recording.mp3');
      return null;
    }),
    readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(1024)),
    create: jest.fn().mockResolvedValue(undefined),
    modify: jest.fn().mockResolvedValue(undefined),
  } as unknown as Vault;
}

function createMockDeps(vault?: Vault) {
  return {
    vault: vault || createMockVault(),
    ocrDeps: {
      generateWithVision: jest.fn().mockResolvedValue('OCR extracted text'),
    },
    transcriptionService: {
      transcribe: jest.fn().mockResolvedValue({ segments: [] }),
    },
  };
}

describe('IngestionPipelineService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // File not found / unsupported type
  // ==========================================================================

  describe('validation', () => {
    it('should return error when file does not exist', async () => {
      const vault = createMockVault({ fileExists: false });
      vault.getFileByPath = jest.fn().mockReturnValue(null);
      const deps = createMockDeps(vault);
      const request: IngestFileRequest = { filePath: 'nonexistent.pdf' };

      const result = await processFile(request, deps);

      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
    });

    it('should return error for unsupported file type', async () => {
      const vault = createMockVault();
      vault.getFileByPath = jest.fn().mockReturnValue(new TFile('image.png', 'notes/image.png'));
      const deps = createMockDeps(vault);
      const request: IngestFileRequest = { filePath: 'notes/image.png' };

      const result = await processFile(request, deps);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported file type');
    });

    it('should return error for XLSX files because spreadsheet ingestion is optional', async () => {
      const deps = createMockDeps();
      const request: IngestFileRequest = { filePath: 'notes/finance.xlsx' };

      const result = await processFile(request, deps);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported file type');
    });
  });

  // ==========================================================================
  // PDF text mode routing
  // ==========================================================================

  describe('PDF text mode', () => {
    it('should route to extractPdfText in text mode', async () => {
      const pages: PdfPageContent[] = [
        { pageNumber: 1, text: 'Extracted text' },
      ];
      extractPdfTextMock.mockResolvedValue(pages);
      const deps = createMockDeps();
      const request: IngestFileRequest = { filePath: 'notes/report.pdf', mode: 'text' };

      const result = await processFile(request, deps);

      expect(extractPdfTextMock).toHaveBeenCalled();
      expect(ocrPdfMock).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.pageCount).toBe(1);
    });

    it('should default to text mode when mode is not specified', async () => {
      extractPdfTextMock.mockResolvedValue([{ pageNumber: 1, text: 'Default text' }]);
      const deps = createMockDeps();
      const request: IngestFileRequest = { filePath: 'notes/report.pdf' };

      await processFile(request, deps);

      expect(extractPdfTextMock).toHaveBeenCalled();
      expect(ocrPdfMock).not.toHaveBeenCalled();
    });

    it('should warn about empty pages in text mode', async () => {
      extractPdfTextMock.mockResolvedValue([
        { pageNumber: 1, text: '' },
        { pageNumber: 2, text: 'Content' },
      ]);
      const deps = createMockDeps();
      const request: IngestFileRequest = { filePath: 'notes/report.pdf', mode: 'text' };

      const result = await processFile(request, deps);

      expect(result.success).toBe(true);
      expect(result.warnings).toBeDefined();
      const [firstWarning = ''] = result.warnings ?? [];
      expect(firstWarning).toContain('1 page(s) had no extractable text');
      expect(firstWarning).toContain('vision mode');
    });

    it('should create output .md note', async () => {
      extractPdfTextMock.mockResolvedValue([{ pageNumber: 1, text: 'Content' }]);
      const deps = createMockDeps();
      const request: IngestFileRequest = { filePath: 'notes/report.pdf' };

      const result = await processFile(request, deps);

      expect(deps.vault.create).toHaveBeenCalledWith(
        'notes/report.md',
        expect.stringContaining('![[report.pdf]]')
      );
      expect(result.outputPath).toBe('notes/report.md');
    });
  });

  // ==========================================================================
  // PDF vision mode routing
  // ==========================================================================

  describe('PDF vision mode', () => {
    it('should route to ocrPdf in vision mode', async () => {
      ocrPdfMock.mockResolvedValue([{ pageNumber: 1, text: 'OCR text' }]);
      const deps = createMockDeps();
      const request: IngestFileRequest = {
        filePath: 'notes/report.pdf',
        mode: 'vision',
        ocrProvider: 'openai',
        ocrModel: 'gpt-5.4',
      };

      const result = await processFile(request, deps);

      expect(ocrPdfMock).toHaveBeenCalled();
      expect(extractPdfTextMock).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should throw when vision mode is missing provider/model', async () => {
      const deps = createMockDeps();
      const request: IngestFileRequest = {
        filePath: 'notes/report.pdf',
        mode: 'vision',
      };

      await expect(processFile(request, deps)).rejects.toThrow(
        'Vision mode requires ocrProvider and ocrModel'
      );
    });
  });

  // ==========================================================================
  // Audio routing
  // ==========================================================================

  describe('audio transcription', () => {
    it('should route audio files to transcriptionService.transcribe', async () => {
      const deps = createMockDeps();
      (deps.transcriptionService.transcribe as jest.Mock).mockResolvedValue({
        segments: [{ startSeconds: 0, endSeconds: 10, text: 'Hello world' }],
      });
      const request: IngestFileRequest = {
        filePath: 'notes/recording.mp3',
        transcriptionProvider: 'openai',
        transcriptionModel: 'whisper-1',
      };

      const result = await processFile(request, deps);

      expect(deps.transcriptionService.transcribe).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.durationSeconds).toBe(10);
    });

    it('should throw when audio is missing transcriptionProvider', async () => {
      const deps = createMockDeps();
      const request: IngestFileRequest = { filePath: 'notes/recording.mp3' };

      await expect(processFile(request, deps)).rejects.toThrow(
        'Audio transcription requires a transcriptionProvider'
      );
    });

    it('should create .md output from audio transcription', async () => {
      const deps = createMockDeps();
      (deps.transcriptionService.transcribe as jest.Mock).mockResolvedValue({
        segments: [{ startSeconds: 0, endSeconds: 5, text: 'Transcribed text' }],
      });
      const request: IngestFileRequest = {
        filePath: 'notes/recording.mp3',
        transcriptionProvider: 'openai',
      };

      const result = await processFile(request, deps);

      expect(deps.vault.create).toHaveBeenCalledWith(
        'notes/recording.md',
        expect.stringContaining('![[recording.mp3]]')
      );
      expect(result.outputPath).toBe('notes/recording.md');
    });
  });

  // ==========================================================================
  // DOCX/PPTX routing
  // ==========================================================================

  describe('office document conversion', () => {
    it('should route DOCX files to extractDocxMarkdown', async () => {
      extractDocxMarkdownMock.mockResolvedValue({
        markdown: '# Proposal\n\nBody',
        warnings: []
      });
      const deps = createMockDeps();
      const request: IngestFileRequest = { filePath: 'notes/proposal.docx' };

      const result = await processFile(request, deps);

      expect(extractDocxMarkdownMock).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.outputPath).toBe('notes/proposal.md');
      expect(deps.vault.create).toHaveBeenCalledWith(
        'notes/proposal.md',
        expect.stringContaining('![[proposal.docx]]')
      );
    });

    it('should route PPTX files to extractPptxContent', async () => {
      extractPptxContentMock.mockResolvedValue({
        slides: [
          { slideNumber: 1, text: 'Executive summary' },
          { slideNumber: 2, text: 'Roadmap', notes: 'Keep this slide short' }
        ],
        warnings: []
      });
      const deps = createMockDeps();
      const request: IngestFileRequest = { filePath: 'notes/deck.pptx' };

      const result = await processFile(request, deps);

      expect(extractPptxContentMock).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.outputPath).toBe('notes/deck.md');
      expect(deps.vault.create).toHaveBeenCalledWith(
        'notes/deck.md',
        expect.stringContaining('## Slide 1')
      );
    });

  });

  // ==========================================================================
  // Output path and existing file handling
  // ==========================================================================

  describe('output file handling', () => {
    it('should overwrite existing output file via modify', async () => {
      const vault = createMockVault({ existingOutput: true });
      extractPdfTextMock.mockResolvedValue([{ pageNumber: 1, text: 'New content' }]);
      const deps = createMockDeps(vault);
      const request: IngestFileRequest = { filePath: 'notes/report.pdf' };

      await processFile(request, deps);

      expect(vault.modify).toHaveBeenCalled();
      expect(vault.create).not.toHaveBeenCalled();
    });

    it('should include processingTimeMs in result', async () => {
      extractPdfTextMock.mockResolvedValue([{ pageNumber: 1, text: 'Content' }]);
      const deps = createMockDeps();
      const request: IngestFileRequest = { filePath: 'notes/report.pdf' };

      const result = await processFile(request, deps);

      expect(result.processingTimeMs).toBeDefined();
      expect(typeof result.processingTimeMs).toBe('number');
      expect(result.processingTimeMs ?? -1).toBeGreaterThanOrEqual(0);
    });
  });

  // ==========================================================================
  // Progress callbacks
  // ==========================================================================

  describe('progress callbacks', () => {
    it('should call onProgress for PDF text extraction stages', async () => {
      extractPdfTextMock.mockResolvedValue([{ pageNumber: 1, text: 'Content' }]);
      const deps = createMockDeps();
      const request: IngestFileRequest = { filePath: 'notes/report.pdf' };
      const onProgress = jest.fn();

      await processFile(request, deps, onProgress);

      const stages = onProgress.mock.calls.map(
        (call: [IngestProgress]) => call[0].stage
      );
      expect(stages).toContain('extracting');
      expect(stages).toContain('building');
      expect(stages).toContain('complete');
    });

    it('should call onProgress for audio transcription stages', async () => {
      const deps = createMockDeps();
      (deps.transcriptionService.transcribe as jest.Mock).mockResolvedValue({
        segments: [{ startSeconds: 0, endSeconds: 5, text: 'Hello' }],
      });
      const request: IngestFileRequest = {
        filePath: 'notes/recording.mp3',
        transcriptionProvider: 'openai',
      };
      const onProgress = jest.fn();

      await processFile(request, deps, onProgress);

      const stages = onProgress.mock.calls.map(
        (call: [IngestProgress]) => call[0].stage
      );
      expect(stages).toContain('transcribing');
      expect(stages).toContain('building');
      expect(stages).toContain('complete');
    });

    it('should include filePath in progress callbacks', async () => {
      extractPdfTextMock.mockResolvedValue([{ pageNumber: 1, text: 'Content' }]);
      const deps = createMockDeps();
      const request: IngestFileRequest = { filePath: 'notes/report.pdf' };
      const onProgress = jest.fn();

      await processFile(request, deps, onProgress);

      for (const call of onProgress.mock.calls) {
        expect(call[0].filePath).toBe('notes/report.pdf');
      }
    });

    it('should work without onProgress callback', async () => {
      extractPdfTextMock.mockResolvedValue([{ pageNumber: 1, text: 'Content' }]);
      const deps = createMockDeps();
      const request: IngestFileRequest = { filePath: 'notes/report.pdf' };

      // Should not throw
      const result = await processFile(request, deps);
      expect(result.success).toBe(true);
    });
  });
});
