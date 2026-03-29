/**
 * ComposeTool tests — validates parameter validation, format routing,
 * output conflict resolution, audio platform gating, and timeout.
 *
 * The compose tool orchestrates FileReader + format-specific composers.
 * Tests mock at the vault + composer boundaries.
 */

import { TFile, TFolder, Vault, Platform, normalizePath } from 'obsidian';

// Mock pdf-lib to prevent import errors in PdfComposer
jest.mock('pdf-lib', () => ({
  PDFDocument: {
    create: jest.fn().mockResolvedValue({
      copyPages: jest.fn().mockResolvedValue([]),
      addPage: jest.fn(),
      save: jest.fn().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    }),
    load: jest.fn().mockResolvedValue({
      getPageIndices: () => [0],
    }),
  },
}));

import { ComposeTool } from '../../src/agents/apps/composer/tools/compose';
import { BaseAppAgent } from '../../src/agents/apps/BaseAppAgent';

function makeTFile(name: string, path?: string, size: number = 1024): TFile {
  const file = new TFile(name, path ?? name);
  (file as any).stat = { size, mtime: Date.now(), ctime: Date.now() };
  return file;
}

function makeVault(opts: {
  files?: Record<string, TFile>;
  textContent?: Record<string, string>;
  binaryContent?: Record<string, ArrayBuffer>;
  abstractFiles?: Record<string, any>;
} = {}): Vault {
  const vault = new Vault();
  (vault as any).getFileByPath = jest.fn((p: string) => opts.files?.[p] ?? null);
  (vault as any).getAbstractFileByPath = jest.fn((p: string) => opts.abstractFiles?.[p] ?? opts.files?.[p] ?? null);
  (vault as any).read = jest.fn((file: TFile) =>
    Promise.resolve(opts.textContent?.[file.path] ?? 'default content')
  );
  (vault as any).readBinary = jest.fn((file: TFile) =>
    Promise.resolve(opts.binaryContent?.[file.path] ?? new ArrayBuffer(8))
  );
  (vault as any).create = jest.fn().mockResolvedValue(undefined);
  (vault as any).createBinary = jest.fn().mockResolvedValue(undefined);
  (vault as any).createFolder = jest.fn().mockResolvedValue(undefined);
  (vault as any).delete = jest.fn().mockResolvedValue(undefined);
  return vault;
}

function makeAgent(vault: Vault): BaseAppAgent {
  // Create a minimal mock of BaseAppAgent with getVault
  const agent = {
    getVault: () => vault,
  } as unknown as BaseAppAgent;
  return agent;
}

// Use fake timers to prevent the 30s Promise.race timeout in compose.ts from leaking
beforeAll(() => jest.useFakeTimers());
afterAll(() => jest.useRealTimers());

describe('ComposeTool', () => {
  let vault: Vault;
  let tool: ComposeTool;

  afterEach(() => {
    jest.runOnlyPendingTimers();
  });

  beforeEach(() => {
    const file1 = makeTFile('notes/a.md', 'notes/a.md', 500);
    const file2 = makeTFile('notes/b.md', 'notes/b.md', 800);

    vault = makeVault({
      files: { 'notes/a.md': file1, 'notes/b.md': file2 },
      textContent: {
        'notes/a.md': 'Content A',
        'notes/b.md': 'Content B',
      },
    });
    const agent = makeAgent(vault);
    tool = new ComposeTool(agent);
  });

  describe('parameter validation', () => {
    it('should reject invalid output path (directory traversal)', async () => {
      const result = await tool.execute({
        format: 'markdown',
        outputPath: '../outside/output.md',
        files: ['notes/a.md'],
      });

      expect(result.success).toBe(false);
      expect((result as any).error).toContain('Invalid output path');
    });

    it('should reject absolute output path', async () => {
      const result = await tool.execute({
        format: 'markdown',
        outputPath: '/etc/output.md',
        files: ['notes/a.md'],
      });

      expect(result.success).toBe(false);
      expect((result as any).error).toContain('Invalid output path');
    });

    it('should require files array for non-mix mode', async () => {
      const result = await tool.execute({
        format: 'markdown',
        outputPath: 'output.md',
        // files missing
      });

      expect(result.success).toBe(false);
      expect((result as any).error).toContain('At least one file');
    });

    it('should require tracks array for audio mix mode', async () => {
      const result = await tool.execute({
        format: 'audio',
        outputPath: 'output.wav',
        audioMode: 'mix',
        // tracks missing
      });

      expect(result.success).toBe(false);
      expect((result as any).error).toContain('tracks');
    });

    it('should validate track file paths in mix mode', async () => {
      const result = await tool.execute({
        format: 'audio',
        outputPath: 'output.wav',
        audioMode: 'mix',
        tracks: [{ file: '../escape.mp3' }],
      });

      expect(result.success).toBe(false);
      expect((result as any).error).toContain('Invalid track file path');
    });
  });

  describe('output conflict resolution', () => {
    it('should error when output exists and overwrite is false (default)', async () => {
      // Set up vault to find existing file at output path
      const existingFile = makeTFile('output.md', 'output.md');
      (vault as any).getAbstractFileByPath = jest.fn((p: string) => {
        if (p === 'output.md') return existingFile;
        return null;
      });

      const result = await tool.execute({
        format: 'markdown',
        outputPath: 'output.md',
        files: ['notes/a.md'],
      });

      expect(result.success).toBe(false);
      expect((result as any).error).toContain('File already exists');
      expect((result as any).error).toContain('overwrite: true');
    });

    it('should delete existing file when overwrite is true', async () => {
      const file1 = makeTFile('notes/a.md', 'notes/a.md', 500);
      const existingOutput = makeTFile('output.md', 'output.md');

      vault = makeVault({
        files: { 'notes/a.md': file1 },
        textContent: { 'notes/a.md': 'Content A' },
        abstractFiles: { 'output.md': existingOutput },
      });

      // After delete, getAbstractFileByPath should return null for the output path
      let deleted = false;
      (vault as any).delete = jest.fn(() => { deleted = true; return Promise.resolve(); });
      (vault as any).getAbstractFileByPath = jest.fn((p: string) => {
        if (p === 'output.md' && !deleted) return existingOutput;
        return vault.getFileByPath?.(p) ?? null;
      });

      const agent = makeAgent(vault);
      tool = new ComposeTool(agent);

      const result = await tool.execute({
        format: 'markdown',
        outputPath: 'output.md',
        files: ['notes/a.md'],
        overwrite: true,
      });

      expect(vault.delete).toHaveBeenCalledWith(existingOutput);
      expect(result.success).toBe(true);
    });
  });

  describe('format routing', () => {
    it('should route markdown format to TextComposer', async () => {
      const result = await tool.execute({
        format: 'markdown',
        outputPath: 'output.md',
        files: ['notes/a.md', 'notes/b.md'],
      });

      expect(result.success).toBe(true);
      expect((result as any).data.path).toBe('output.md');
      expect((result as any).data.fileCount).toBe(2);
      // TextComposer outputs string → vault.create is called (not createBinary)
      expect(vault.create).toHaveBeenCalled();
    });

    it('should route pdf format to PdfComposer', async () => {
      const pdfFile = makeTFile('doc.pdf', 'doc.pdf', 2048);
      vault = makeVault({
        files: { 'doc.pdf': pdfFile },
        binaryContent: { 'doc.pdf': new ArrayBuffer(16) },
      });
      const agent = makeAgent(vault);
      tool = new ComposeTool(agent);

      const result = await tool.execute({
        format: 'pdf',
        outputPath: 'merged.pdf',
        files: ['doc.pdf'],
      });

      expect(result.success).toBe(true);
      // PdfComposer outputs Uint8Array → vault.createBinary is called
      expect(vault.createBinary).toHaveBeenCalled();
    });
  });

  describe('audio platform gating', () => {
    it('should reject audio format on non-desktop platform', async () => {
      // Temporarily mock Platform.isDesktop = false
      const origIsDesktop = Platform.isDesktop;
      (Platform as any).isDesktop = false;

      try {
        const audioFile = makeTFile('song.mp3', 'song.mp3', 4096);
        vault = makeVault({ files: { 'song.mp3': audioFile } });
        const agent = makeAgent(vault);
        tool = new ComposeTool(agent);

        const result = await tool.execute({
          format: 'audio',
          outputPath: 'output.wav',
          files: ['song.mp3'],
        });

        expect(result.success).toBe(false);
        expect((result as any).error).toContain('not available on this platform');
      } finally {
        (Platform as any).isDesktop = origIsDesktop;
      }
    });
  });

  describe('vault not available', () => {
    it('should return error when vault is null', async () => {
      const agent = { getVault: () => null } as unknown as BaseAppAgent;
      tool = new ComposeTool(agent);

      const result = await tool.execute({
        format: 'markdown',
        outputPath: 'output.md',
        files: ['a.md'],
      });

      expect(result.success).toBe(false);
      expect((result as any).error).toContain('Vault not available');
    });
  });

  describe('file resolution errors', () => {
    it('should return error when input files not found', async () => {
      const result = await tool.execute({
        format: 'markdown',
        outputPath: 'output.md',
        files: ['nonexistent.md'],
      });

      expect(result.success).toBe(false);
      expect((result as any).error).toContain('could not be resolved');
    });
  });

  describe('output directory creation', () => {
    it('should create parent directories for nested output path', async () => {
      const file = makeTFile('notes/a.md', 'notes/a.md', 500);
      vault = makeVault({
        files: { 'notes/a.md': file },
        textContent: { 'notes/a.md': 'Content' },
      });
      const agent = makeAgent(vault);
      tool = new ComposeTool(agent);

      const result = await tool.execute({
        format: 'markdown',
        outputPath: 'deep/nested/output.md',
        files: ['notes/a.md'],
      });

      expect(result.success).toBe(true);
      expect(vault.createFolder).toHaveBeenCalledWith('deep/nested');
    });
  });

  describe('result shape', () => {
    it('should return fileCount, totalInputSize, outputSize, and path', async () => {
      const result = await tool.execute({
        format: 'markdown',
        outputPath: 'result.md',
        files: ['notes/a.md', 'notes/b.md'],
      });

      expect(result.success).toBe(true);
      const data = (result as any).data;
      expect(data.path).toBe('result.md');
      expect(data.fileCount).toBe(2);
      expect(data.totalInputSize).toBe(1300); // 500 + 800
      expect(typeof data.outputSize).toBe('number');
      expect(data.outputSize).toBeGreaterThan(0);
    });
  });

  describe('getParameterSchema', () => {
    it('should return schema with required fields', () => {
      const schema = tool.getParameterSchema();
      expect(schema).toBeDefined();
      expect(schema.properties).toBeDefined();
      // Check key properties exist
      expect((schema.properties as any).format).toBeDefined();
      expect((schema.properties as any).outputPath).toBeDefined();
      expect((schema.properties as any).files).toBeDefined();
    });
  });
});
