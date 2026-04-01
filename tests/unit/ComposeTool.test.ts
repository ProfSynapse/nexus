/**
 * ComposeTool tests — validates parameter validation, format routing,
 * output conflict resolution, audio platform gating, and timeout.
 *
 * The compose tool orchestrates FileReader + format-specific composers.
 * Tests mock at the vault + composer boundaries.
 */

import { TFile, Vault, Platform } from 'obsidian';

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

type MockVault = Vault & {
  getFileByPath: jest.Mock<TFile | null, [string]>;
  getAbstractFileByPath: jest.Mock<unknown, [string]>;
  read: jest.Mock<Promise<string>, [TFile]>;
  readBinary: jest.Mock<Promise<ArrayBuffer>, [TFile]>;
  create: jest.Mock<Promise<void>, unknown[]>;
  createBinary: jest.Mock<Promise<void>, unknown[]>;
  createFolder: jest.Mock<Promise<void>, unknown[]>;
  delete: jest.Mock<Promise<void>, unknown[]>;
  rename: jest.Mock<Promise<void>, unknown[]>;
};

type ComposeResultData = {
  path: string;
  fileCount: number;
  totalInputSize: number;
  outputSize: number;
};

function asMockVault(vault: Vault): MockVault {
  return vault as unknown as MockVault;
}

function getErrorMessage(result: { success: boolean; error?: string }): string {
  expect(result.success).toBe(false);
  expect(result.error).toBeDefined();
  return result.error as string;
}

function getSuccessData(result: { success: boolean; data?: unknown }): ComposeResultData {
  expect(result.success).toBe(true);
  return result.data as ComposeResultData;
}

function makeTFile(name: string, path?: string, size = 1024): TFile {
  const file = new TFile(name, path ?? name);
  (file as unknown as { stat: { size: number; mtime: number; ctime: number } }).stat = {
    size,
    mtime: Date.now(),
    ctime: Date.now()
  };
  return file;
}

function makeVault(opts: {
  files?: Record<string, TFile>;
  textContent?: Record<string, string>;
  binaryContent?: Record<string, ArrayBuffer>;
  abstractFiles?: Record<string, unknown>;
} = {}): Vault {
  const vault = new Vault();
  const mockVault = asMockVault(vault);
  mockVault.getFileByPath = jest.fn((p: string) => opts.files?.[p] ?? null);
  mockVault.getAbstractFileByPath = jest.fn((p: string) => opts.abstractFiles?.[p] ?? opts.files?.[p] ?? null);
  mockVault.read = jest.fn((file: TFile) =>
    Promise.resolve(opts.textContent?.[file.path] ?? 'default content')
  );
  mockVault.readBinary = jest.fn((file: TFile) =>
    Promise.resolve(opts.binaryContent?.[file.path] ?? new ArrayBuffer(8))
  );
  mockVault.create = jest.fn().mockResolvedValue(undefined);
  mockVault.createBinary = jest.fn().mockResolvedValue(undefined);
  mockVault.createFolder = jest.fn().mockResolvedValue(undefined);
  mockVault.delete = jest.fn().mockResolvedValue(undefined);
  mockVault.rename = jest.fn().mockResolvedValue(undefined);
  return vault;
}

function makeAgent(vault: Vault, app?: { fileManager: { trashFile: jest.Mock } }): BaseAppAgent {
  // Create a minimal mock of BaseAppAgent with getVault
  const agent = {
    getVault: () => vault,
    getApp: () => app ?? null,
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
      expect(getErrorMessage(result)).toContain('Invalid output path');
    });

    it('should reject absolute output path', async () => {
      const result = await tool.execute({
        format: 'markdown',
        outputPath: '/etc/output.md',
        files: ['notes/a.md'],
      });

      expect(result.success).toBe(false);
      expect(getErrorMessage(result)).toContain('Invalid output path');
    });

    it('should require files array for non-mix mode', async () => {
      const result = await tool.execute({
        format: 'markdown',
        outputPath: 'output.md',
        // files missing
      });

      expect(result.success).toBe(false);
      expect(getErrorMessage(result)).toContain('At least one file');
    });

    it('should require tracks array for audio mix mode', async () => {
      const result = await tool.execute({
        format: 'audio',
        outputPath: 'output.wav',
        audioMode: 'mix',
        // tracks missing
      });

      expect(result.success).toBe(false);
      expect(getErrorMessage(result)).toContain('tracks');
    });

    it('should validate track file paths in mix mode', async () => {
      const result = await tool.execute({
        format: 'audio',
        outputPath: 'output.wav',
        audioMode: 'mix',
        tracks: [{ file: '../escape.mp3' }],
      });

      expect(result.success).toBe(false);
      expect(getErrorMessage(result)).toContain('Invalid track file path');
    });
  });

  describe('output conflict resolution', () => {
    it('should error when output exists and overwrite is false (default)', async () => {
      // Set up vault to find existing file at output path
      const existingFile = makeTFile('output.md', 'output.md');
      asMockVault(vault).getAbstractFileByPath = jest.fn((p: string) => {
        if (p === 'output.md') return existingFile;
        return null;
      });

      const result = await tool.execute({
        format: 'markdown',
        outputPath: 'output.md',
        files: ['notes/a.md'],
      });

      expect(result.success).toBe(false);
      expect(getErrorMessage(result)).toContain('File already exists');
      expect(getErrorMessage(result)).toContain('overwrite: true');
    });

    it('should trash existing file through the file manager when overwrite is true', async () => {
      const file1 = makeTFile('notes/a.md', 'notes/a.md', 500);
      const existingOutput = makeTFile('output.md', 'output.md');
      const tempOutput = makeTFile('output.md.composing', 'output.md.composing');
      let deleted = false;
      let tempCreated = false;
      const trashFile = jest.fn(async () => {
        deleted = true;
      });

      vault = makeVault({
        files: { 'notes/a.md': file1 },
        textContent: { 'notes/a.md': 'Content A' },
        abstractFiles: { 'output.md': existingOutput },
      });

      asMockVault(vault).create = jest.fn(async (_path: string) => {
        tempCreated = true;
      });
      asMockVault(vault).rename = jest.fn(async () => {
        tempCreated = false;
      });
      asMockVault(vault).getAbstractFileByPath = jest.fn((p: string) => {
        if (p === 'output.md' && !deleted) return existingOutput;
        if (p === 'output.md.composing' && tempCreated) return tempOutput;
        return null;
      });

      const agent = makeAgent(vault, { fileManager: { trashFile } });
      tool = new ComposeTool(agent);

      const result = await tool.execute({
        format: 'markdown',
        outputPath: 'output.md',
        files: ['notes/a.md'],
        overwrite: true,
      });

      expect(trashFile).toHaveBeenCalledWith(existingOutput);
      expect(vault.create).toHaveBeenCalledWith('output.md.composing', expect.any(String));
      expect(vault.rename).toHaveBeenCalledWith(tempOutput, 'output.md');
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
      const data = getSuccessData(result);
      expect(data.path).toBe('output.md');
      expect(data.fileCount).toBe(2);
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
      (Platform as unknown as { isDesktop: boolean }).isDesktop = false;

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
        expect(getErrorMessage(result)).toContain('not available on this platform');
      } finally {
        (Platform as unknown as { isDesktop: boolean }).isDesktop = origIsDesktop;
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
      expect(getErrorMessage(result)).toContain('Vault not available');
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
      expect(getErrorMessage(result)).toContain('could not be resolved');
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
      const data = getSuccessData(result);
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
      const properties = schema.properties as Record<string, unknown>;
      expect(properties.format).toBeDefined();
      expect(properties.outputPath).toBeDefined();
      expect(properties.files).toBeDefined();
    });
  });
});
