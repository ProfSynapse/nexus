/**
 * PdfComposer tests — validates PDF merging via mocked pdf-lib.
 *
 * Covers: 2-PDF merge, corrupted PDF returns failedFiles[],
 * empty files array, mix mode rejection.
 */

import { PdfComposer } from '../../src/agents/apps/composer/services/PdfComposer';
import { ComposerError } from '../../src/agents/apps/composer/types';
import { TFile, Vault } from 'obsidian';

type MockTFile = TFile & {
  stat: { size: number; mtime: number; ctime: number };
};

type VaultWithReadBinary = Vault & {
  readBinary: jest.Mock<Promise<ArrayBuffer>, [TFile]>;
};

// Mock pdf-lib at module level.
// The mock factory below is hoisted, so we cannot reference `const` variables.
// Instead, we use `jest.requireMock` to access mock functions in tests.
jest.mock('pdf-lib', () => {
  const copyPages = jest.fn();
  const addPage = jest.fn();
  const save = jest.fn().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  const load = jest.fn();

  return {
    PDFDocument: {
      create: jest.fn().mockResolvedValue({ copyPages, addPage, save }),
      load,
    },
    // Expose individual mocks for test assertions
    __mocks: { copyPages, addPage, save, load },
  };
});

// Access mock functions
const { __mocks: pdfMocks } = jest.requireMock('pdf-lib') as {
  __mocks: {
    copyPages: jest.Mock;
    addPage: jest.Mock;
    save: jest.Mock;
    load: jest.Mock;
  };
};

function makeTFile(name: string, path?: string): TFile {
  const file = new TFile(name, path ?? name);
  (file as MockTFile).stat = { size: 1024, mtime: Date.now(), ctime: Date.now() };
  return file;
}

function makeVault(binaryMap: Record<string, ArrayBuffer>): Vault {
  const vault = new Vault();
  (vault as VaultWithReadBinary).readBinary = jest.fn((file: TFile) => {
    return Promise.resolve(binaryMap[file.path] ?? new ArrayBuffer(0));
  });
  return vault;
}

describe('PdfComposer', () => {
  let composer: PdfComposer;

  beforeEach(() => {
    composer = new PdfComposer();
    jest.clearAllMocks();

    // Default mock behavior: each loaded PDF has 2 pages
    pdfMocks.load.mockResolvedValue({
      getPageIndices: () => [0, 1],
    });
    pdfMocks.copyPages.mockResolvedValue([{ mockPage: 1 }, { mockPage: 2 }]);
    pdfMocks.save.mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46])); // %PDF
  });

  it('should report supported extensions', () => {
    expect(composer.supportedExtensions).toContain('pdf');
    expect(composer.isAvailableOnPlatform).toBe(true);
  });

  it('should reject mix mode', async () => {
    const vault = makeVault({});
    await expect(
      composer.compose({ mode: 'mix', tracks: [] } as Parameters<PdfComposer['compose']>[0], vault, {})
    ).rejects.toThrow(ComposerError);
  });

  it('should merge 2 PDFs successfully', async () => {
    const file1 = makeTFile('doc1.pdf');
    const file2 = makeTFile('doc2.pdf');
    const buf1 = new ArrayBuffer(16);
    const buf2 = new ArrayBuffer(16);
    const vault = makeVault({ 'doc1.pdf': buf1, 'doc2.pdf': buf2 });

    const result = await composer.compose(
      { mode: 'concat', files: [file1, file2] },
      vault,
      {}
    );

    expect(result).toBeInstanceOf(Uint8Array);
    expect(pdfMocks.load).toHaveBeenCalledTimes(2);
    // Each PDF's pages should be copied and added
    expect(pdfMocks.copyPages).toHaveBeenCalledTimes(2);
    // 2 pages per PDF * 2 PDFs = 4 addPage calls
    expect(pdfMocks.addPage).toHaveBeenCalledTimes(4);
    expect(pdfMocks.save).toHaveBeenCalledTimes(1);
  });

  it('should throw ComposerError with failedFiles for corrupted PDF', async () => {
    const goodFile = makeTFile('good.pdf');
    const badFile = makeTFile('corrupt.pdf');
    const vault = makeVault({
      'good.pdf': new ArrayBuffer(16),
      'corrupt.pdf': new ArrayBuffer(8),
    });

    // First PDF loads fine, second throws
    pdfMocks.load
      .mockResolvedValueOnce({ getPageIndices: () => [0] })
      .mockRejectedValueOnce(new Error('Invalid PDF structure'));

    // First PDF copy succeeds
    pdfMocks.copyPages.mockResolvedValueOnce([{ mockPage: 1 }]);

    try {
      await composer.compose(
        { mode: 'concat', files: [goodFile, badFile] },
        vault,
        {}
      );
      fail('Expected ComposerError');
    } catch (err) {
      expect(err).toBeInstanceOf(ComposerError);
      const ce = err as ComposerError;
      expect(ce.failedFiles).toContain('corrupt.pdf');
      expect(ce.message).toContain('corrupt.pdf');
    }
  });

  it('should handle empty files array', async () => {
    const vault = makeVault({});

    const result = await composer.compose(
      { mode: 'concat', files: [] },
      vault,
      {}
    );

    // Empty input = just an empty PDF
    expect(result).toBeInstanceOf(Uint8Array);
    expect(pdfMocks.load).not.toHaveBeenCalled();
    expect(pdfMocks.save).toHaveBeenCalledTimes(1);
  });

  it('should handle single PDF', async () => {
    const file = makeTFile('single.pdf');
    const vault = makeVault({ 'single.pdf': new ArrayBuffer(16) });

    pdfMocks.load.mockResolvedValueOnce({ getPageIndices: () => [0, 1, 2] });
    pdfMocks.copyPages.mockResolvedValueOnce([{ p: 1 }, { p: 2 }, { p: 3 }]);

    const result = await composer.compose(
      { mode: 'concat', files: [file] },
      vault,
      {}
    );

    expect(result).toBeInstanceOf(Uint8Array);
    expect(pdfMocks.load).toHaveBeenCalledTimes(1);
    expect(pdfMocks.addPage).toHaveBeenCalledTimes(3);
  });

  it('should pass ignoreEncryption option to PDFDocument.load', async () => {
    const file = makeTFile('encrypted.pdf');
    const vault = makeVault({ 'encrypted.pdf': new ArrayBuffer(16) });

    pdfMocks.load.mockResolvedValueOnce({ getPageIndices: () => [0] });
    pdfMocks.copyPages.mockResolvedValueOnce([{ p: 1 }]);

    await composer.compose(
      { mode: 'concat', files: [file] },
      vault,
      {}
    );

    expect(pdfMocks.load).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      { ignoreEncryption: true }
    );
  });
});
