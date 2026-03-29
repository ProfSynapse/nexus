/**
 * TextComposer tests — validates markdown concatenation, frontmatter handling,
 * file headers, and separator configuration.
 *
 * TextComposer implements IFormatComposer and operates as a pure string
 * transformer — it reads files via vault.read() and returns composed text.
 */

import { TextComposer } from '../../src/agents/apps/composer/services/TextComposer';
import { ComposeOptions, ComposerError } from '../../src/agents/apps/composer/types';
import { TFile, Vault } from 'obsidian';

function makeTFile(name: string, path?: string): TFile {
  const file = new TFile(name, path ?? name);
  (file as any).stat = { size: 100, mtime: Date.now(), ctime: Date.now() };
  return file;
}

function makeVault(contentMap: Record<string, string>): Vault {
  const vault = new Vault();
  (vault as any).read = jest.fn((file: TFile) => {
    return Promise.resolve(contentMap[file.path] ?? '');
  });
  return vault;
}

describe('TextComposer', () => {
  let composer: TextComposer;

  beforeEach(() => {
    composer = new TextComposer();
  });

  it('should report supported extensions', () => {
    expect(composer.supportedExtensions).toContain('md');
    expect(composer.supportedExtensions).toContain('txt');
    expect(composer.isAvailableOnPlatform).toBe(true);
  });

  it('should reject mix mode', async () => {
    const vault = makeVault({});
    await expect(
      composer.compose({ mode: 'mix', tracks: [] } as any, vault, {})
    ).rejects.toThrow(ComposerError);
  });

  describe('basic concatenation', () => {
    it('should concatenate 2 files with default separator', async () => {
      const file1 = makeTFile('a.md');
      const file2 = makeTFile('b.md');
      const vault = makeVault({
        'a.md': 'Content A',
        'b.md': 'Content B',
      });

      const result = await composer.compose(
        { mode: 'concat', files: [file1, file2] },
        vault,
        {}
      );

      expect(result).toBe('Content A\n---\nContent B');
    });

    it('should use custom separator', async () => {
      const file1 = makeTFile('a.md');
      const file2 = makeTFile('b.md');
      const vault = makeVault({ 'a.md': 'A', 'b.md': 'B' });

      const result = await composer.compose(
        { mode: 'concat', files: [file1, file2] },
        vault,
        { separator: '\n\n' }
      );

      expect(result).toBe('A\n\nB');
    });

    it('should handle single file', async () => {
      const file = makeTFile('only.md');
      const vault = makeVault({ 'only.md': 'Single file content' });

      const result = await composer.compose(
        { mode: 'concat', files: [file] },
        vault,
        {}
      );

      expect(result).toBe('Single file content');
    });

    it('should handle empty files array (empty output)', async () => {
      const vault = makeVault({});

      const result = await composer.compose(
        { mode: 'concat', files: [] },
        vault,
        {}
      );

      // No files = empty join
      expect(result).toBe('');
    });
  });

  describe('includeHeaders', () => {
    it('should prepend file basename as heading', async () => {
      const file = makeTFile('intro.md');
      const vault = makeVault({ 'intro.md': 'Some content here' });

      const result = await composer.compose(
        { mode: 'concat', files: [file] },
        vault,
        { includeHeaders: true }
      );

      expect(result).toContain('## intro');
      expect(result).toContain('Some content here');
    });

    it('should use configurable header level', async () => {
      const file = makeTFile('notes.md');
      const vault = makeVault({ 'notes.md': 'Body text' });

      const result = await composer.compose(
        { mode: 'concat', files: [file] },
        vault,
        { includeHeaders: true, headerLevel: 3 }
      );

      expect(result).toContain('### notes');
    });

    it('should default to level 2 heading', async () => {
      const file = makeTFile('test.md');
      const vault = makeVault({ 'test.md': 'Body' });

      const result = await composer.compose(
        { mode: 'concat', files: [file] },
        vault,
        { includeHeaders: true }
      );

      // Default is ##
      expect(result).toMatch(/^## test/);
    });
  });

  describe('frontmatter handling', () => {
    const fmContentA = '---\ntitle: Doc A\nauthor: Alice\n---\nBody A';
    const fmContentB = '---\ntitle: Doc B\ntags: notes\n---\nBody B';
    const noFmContent = 'No frontmatter here';

    it('should keep first file frontmatter with "first" mode (default)', async () => {
      const fileA = makeTFile('a.md');
      const fileB = makeTFile('b.md');
      const vault = makeVault({ 'a.md': fmContentA, 'b.md': fmContentB });

      const result = await composer.compose(
        { mode: 'concat', files: [fileA, fileB] },
        vault,
        { frontmatterHandling: 'first' }
      );

      // First file's frontmatter should be present
      expect(result).toContain('title: Doc A');
      expect(result).toContain('Body A');
      // Second file's frontmatter should be stripped
      expect(result).not.toContain('title: Doc B');
      expect(result).toContain('Body B');
    });

    it('should strip all frontmatter with "strip" mode', async () => {
      const fileA = makeTFile('a.md');
      const fileB = makeTFile('b.md');
      const vault = makeVault({ 'a.md': fmContentA, 'b.md': fmContentB });

      const result = await composer.compose(
        { mode: 'concat', files: [fileA, fileB] },
        vault,
        { frontmatterHandling: 'strip' }
      );

      // Frontmatter blocks stripped — only the default separator '---' remains
      expect(result).not.toContain('title:');
      expect(result).not.toContain('tags:');
      expect(result).toContain('Body A');
      expect(result).toContain('Body B');
    });

    it('should merge all frontmatter with "merge" mode', async () => {
      const fileA = makeTFile('a.md');
      const fileB = makeTFile('b.md');
      const vault = makeVault({ 'a.md': fmContentA, 'b.md': fmContentB });

      const result = await composer.compose(
        { mode: 'concat', files: [fileA, fileB] },
        vault,
        { frontmatterHandling: 'merge' }
      );

      // Merged frontmatter at top
      expect(result).toContain('---');
      // B overwrites A for shared keys (shallow merge)
      expect(result).toContain('title: Doc B');
      // B's unique keys are present
      expect(result).toContain('tags: notes');
      // A's unique keys are present
      expect(result).toContain('author: Alice');
    });

    it('should handle file without frontmatter in merge mode', async () => {
      const fileA = makeTFile('a.md');
      const fileB = makeTFile('b.md');
      const vault = makeVault({ 'a.md': fmContentA, 'b.md': noFmContent });

      const result = await composer.compose(
        { mode: 'concat', files: [fileA, fileB] },
        vault,
        { frontmatterHandling: 'merge' }
      );

      expect(result).toContain('title: Doc A');
      expect(result).toContain('No frontmatter here');
    });

    it('should handle all files without frontmatter in merge mode', async () => {
      const fileA = makeTFile('a.md');
      const vault = makeVault({ 'a.md': noFmContent });

      const result = await composer.compose(
        { mode: 'concat', files: [fileA] },
        vault,
        { frontmatterHandling: 'merge' }
      );

      // No frontmatter block should appear
      expect(result).not.toContain('---');
      expect(result).toBe('No frontmatter here');
    });
  });

  describe('edge cases', () => {
    it('should handle files with BOM characters', async () => {
      const file = makeTFile('bom.md');
      const vault = makeVault({ 'bom.md': '\uFEFF---\ntitle: BOM\n---\nContent' });

      const result = await composer.compose(
        { mode: 'concat', files: [file] },
        vault,
        { frontmatterHandling: 'strip' }
      );

      expect(result).toBe('Content');
    });

    it('should trim whitespace from sections', async () => {
      const file = makeTFile('spaced.md');
      const vault = makeVault({ 'spaced.md': '  \n\nContent with spaces\n\n  ' });

      const result = await composer.compose(
        { mode: 'concat', files: [file] },
        vault,
        {}
      );

      expect(result).toBe('Content with spaces');
    });

    it('should handle headers + frontmatter strip combined', async () => {
      const file = makeTFile('combo.md');
      const vault = makeVault({
        'combo.md': '---\ntitle: Test\n---\nBody content',
      });

      const result = await composer.compose(
        { mode: 'concat', files: [file] },
        vault,
        { includeHeaders: true, frontmatterHandling: 'strip' }
      );

      expect(result).toContain('## combo');
      expect(result).toContain('Body content');
      expect(result).not.toContain('title: Test');
    });
  });
});
