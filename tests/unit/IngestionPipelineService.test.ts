/**
 * IngestionPipelineService Unit Tests
 *
 * Integration-style unit tests that mock the downstream services
 * (OcrService, PdfTextExtractor, TranscriptionService) and verify
 * pipeline routing, output path construction, and progress callbacks.
 */

// Mock pdfjs-dist (used transitively by PdfTextExtractor)
jest.mock('pdfjs-dist', () => ({
  getDocument: jest.fn(),
}));

// Mock PdfTextExtractor
jest.mock(
  '../../src/agents/ingestManager/tools/services/PdfTextExtractor',
  () => ({
    extractPdfText: jest.fn(),
  })
);

// Mock OcrService
jest.mock(
  '../../src/agents/ingestManager/tools/services/OcrService',
  () => ({
    ocrPdf: jest.fn(),
  })
);

// Mock TranscriptionService
jest.mock(
  '../../src/agents/ingestManager/tools/services/TranscriptionService',
  () => ({
    transcribeAudio: jest.fn(),
  })
);

import { processFile } from '../../src/agents/ingestManager/tools/services/IngestionPipelineService';
import { extractPdfText } from '../../src/agents/ingestManager/tools/services/PdfTextExtractor';
import { ocrPdf } from '../../src/agents/ingestManager/tools/services/OcrService';
import { transcribeAudio } from '../../src/agents/ingestManager/tools/services/TranscriptionService';
import {
  IngestFileRequest,
  IngestProgress,
  PdfPageContent,
  TranscriptionSegment,
} from '../../src/agents/ingestManager/types';
import { TFile, Vault } from 'obsidian';

const extractPdfTextMock = extractPdfText as jest.MockedFunction<typeof extractPdfText>;
const ocrPdfMock = ocrPdf as jest.MockedFunction<typeof ocrPdf>;
const transcribeAudioMock = transcribeAudio as jest.MockedFunction<typeof transcribeAudio>;

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
    transcriptionDeps: {
      getApiKey: jest.fn().mockReturnValue('test-api-key'),
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
      expect(result.warnings![0]).toContain('1 page(s) had no extractable text');
      expect(result.warnings![0]).toContain('vision mode');
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
    it('should route audio files to transcribeAudio', async () => {
      const segments: TranscriptionSegment[] = [
        { startSeconds: 0, endSeconds: 10, text: 'Hello world' },
      ];
      transcribeAudioMock.mockResolvedValue(segments);
      const deps = createMockDeps();
      const request: IngestFileRequest = {
        filePath: 'notes/recording.mp3',
        transcriptionProvider: 'openai',
        transcriptionModel: 'whisper-1',
      };

      const result = await processFile(request, deps);

      expect(transcribeAudioMock).toHaveBeenCalled();
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
      transcribeAudioMock.mockResolvedValue([
        { startSeconds: 0, endSeconds: 5, text: 'Transcribed text' },
      ]);
      const deps = createMockDeps();
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
      expect(result.processingTimeMs!).toBeGreaterThanOrEqual(0);
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
      transcribeAudioMock.mockResolvedValue([
        { startSeconds: 0, endSeconds: 5, text: 'Hello' },
      ]);
      const deps = createMockDeps();
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
