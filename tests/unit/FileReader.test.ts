/**
 * FileReader tests — validates path security, file resolution, and vault reads.
 *
 * Covers: isValidPath rejection (traversal, absolute), file not found,
 * file too large (stat.size > limit), text file read via vault.read,
 * binary file read via vault.readBinary.
 */

import { FileReader } from '../../src/agents/apps/composer/services/FileReader';
import { ComposerError } from '../../src/agents/apps/composer/types';
import { TFile, Vault } from 'obsidian';

// Create a TFile stub with stat.size
function makeTFile(path: string, size: number = 1024): TFile {
  const file = new TFile(path.split('/').pop() || path, path);
  (file as any).stat = { size, mtime: Date.now(), ctime: Date.now() };
  return file;
}

function makeVault(fileMap: Record<string, TFile> = {}): Vault {
  const vault = new Vault();
  (vault as any).getFileByPath = jest.fn((p: string) => fileMap[p] ?? null);
  (vault as any).read = jest.fn().mockResolvedValue('text content');
  (vault as any).readBinary = jest.fn().mockResolvedValue(new ArrayBuffer(8));
  return vault;
}

describe('FileReader', () => {
  describe('resolveFiles', () => {
    it('should resolve valid vault-relative paths', () => {
      const file1 = makeTFile('notes/file1.md', 500);
      const file2 = makeTFile('notes/file2.md', 800);
      const vault = makeVault({ 'notes/file1.md': file1, 'notes/file2.md': file2 });
      const reader = new FileReader(vault, 50);

      const result = reader.resolveFiles(['notes/file1.md', 'notes/file2.md']);

      expect(result).toHaveLength(2);
      expect(result[0]).toBe(file1);
      expect(result[1]).toBe(file2);
    });

    it('should reject paths with directory traversal (..)', () => {
      const vault = makeVault();
      const reader = new FileReader(vault, 50);

      expect(() => reader.resolveFiles(['../secret/file.md']))
        .toThrow(ComposerError);
      expect(() => reader.resolveFiles(['notes/../../../etc/passwd']))
        .toThrow(ComposerError);
    });

    it('should reject absolute paths', () => {
      const vault = makeVault();
      const reader = new FileReader(vault, 50);

      expect(() => reader.resolveFiles(['/etc/passwd']))
        .toThrow(ComposerError);
      expect(() => reader.resolveFiles(['/root/file.md']))
        .toThrow(ComposerError);
    });

    it('should reject paths with invalid characters', () => {
      const vault = makeVault();
      const reader = new FileReader(vault, 50);

      expect(() => reader.resolveFiles(['file<name>.md']))
        .toThrow(ComposerError);
      expect(() => reader.resolveFiles(['file|name.md']))
        .toThrow(ComposerError);
    });

    it('should throw ComposerError when file is not found in vault', () => {
      const vault = makeVault({});
      const reader = new FileReader(vault, 50);

      try {
        reader.resolveFiles(['nonexistent.md']);
        fail('Expected ComposerError');
      } catch (err) {
        expect(err).toBeInstanceOf(ComposerError);
        expect((err as ComposerError).failedFiles).toContain('nonexistent.md');
      }
    });

    it('should throw ComposerError when file exceeds size limit', () => {
      const bigFile = makeTFile('big.pdf', 60 * 1024 * 1024); // 60MB
      const vault = makeVault({ 'big.pdf': bigFile });
      const reader = new FileReader(vault, 50); // 50MB limit

      try {
        reader.resolveFiles(['big.pdf']);
        fail('Expected ComposerError');
      } catch (err) {
        expect(err).toBeInstanceOf(ComposerError);
        expect((err as ComposerError).failedFiles).toContain('big.pdf');
        expect((err as ComposerError).message).toContain('50MB');
      }
    });

    it('should allow files under the size limit', () => {
      const file = makeTFile('small.pdf', 10 * 1024 * 1024); // 10MB
      const vault = makeVault({ 'small.pdf': file });
      const reader = new FileReader(vault, 50);

      const result = reader.resolveFiles(['small.pdf']);
      expect(result).toHaveLength(1);
    });

    it('should use configurable max file size', () => {
      const file = makeTFile('medium.pdf', 3 * 1024 * 1024); // 3MB
      const vault = makeVault({ 'medium.pdf': file });
      const reader = new FileReader(vault, 2); // 2MB limit

      expect(() => reader.resolveFiles(['medium.pdf']))
        .toThrow(ComposerError);
    });

    it('should collect all failed files in a single error', () => {
      const goodFile = makeTFile('good.md', 100);
      const vault = makeVault({ 'good.md': goodFile });
      const reader = new FileReader(vault, 50);

      try {
        reader.resolveFiles(['../bad.md', 'missing.md', 'good.md']);
        fail('Expected ComposerError');
      } catch (err) {
        expect(err).toBeInstanceOf(ComposerError);
        const ce = err as ComposerError;
        expect(ce.failedFiles).toHaveLength(2);
        expect(ce.failedFiles).toContain('../bad.md');
        expect(ce.failedFiles).toContain('missing.md');
      }
    });

    it('should handle empty string path', () => {
      const vault = makeVault();
      const reader = new FileReader(vault, 50);

      expect(() => reader.resolveFiles(['']))
        .toThrow(ComposerError);
    });
  });

  describe('readText', () => {
    it('should read text content via vault.read', async () => {
      const file = makeTFile('note.md');
      const vault = makeVault();
      (vault as any).read = jest.fn().mockResolvedValue('# Hello World');
      const reader = new FileReader(vault, 50);

      const content = await reader.readText(file);

      expect(content).toBe('# Hello World');
      expect(vault.read).toHaveBeenCalledWith(file);
    });
  });

  describe('readBinary', () => {
    it('should read binary content via vault.readBinary', async () => {
      const file = makeTFile('doc.pdf');
      const vault = makeVault();
      const mockBuffer = new ArrayBuffer(16);
      (vault as any).readBinary = jest.fn().mockResolvedValue(mockBuffer);
      const reader = new FileReader(vault, 50);

      const content = await reader.readBinary(file);

      expect(content).toBe(mockBuffer);
      expect(vault.readBinary).toHaveBeenCalledWith(file);
    });
  });
});
