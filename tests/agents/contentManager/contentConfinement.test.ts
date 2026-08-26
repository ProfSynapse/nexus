/**
 * Regression tests: the contentManager write boundary confines caller paths to
 * the vault. `../` and absolute paths must be rejected WITHOUT any vault write,
 * while normal vault-relative writes still succeed.
 * See docs/plans/vault-path-confinement-plan.md.
 */

import { TFile } from 'obsidian';
import { WriteTool } from '@/agents/contentManager/tools/write';
import { InsertTool } from '@/agents/contentManager/tools/insert';
import { ReplaceTool } from '@/agents/contentManager/tools/replace';
import { SetPropertyTool } from '@/agents/contentManager/tools/setProperty';
import { RemovePropertyTool } from '@/agents/contentManager/tools/removeProperty';
import { ContentOperations } from '@/agents/contentManager/utils/ContentOperations';

// A POSIX leading slash (/tmp/ESCAPE.md) is stripped to vault-relative (backward-compat), not an escape.
const ESCAPING = ['../../../../tmp/ESCAPE.md', '~/ESCAPE.md', '..\\..\\ESCAPE.md'];

interface MockVault {
  create: jest.Mock;
  modify: jest.Mock;
  createFolder: jest.Mock;
  read: jest.Mock;
  getAbstractFileByPath: jest.Mock;
}

function makeApp(existing?: TFile, frontmatter: Record<string, unknown> = {}): { app: any; vault: MockVault; processFrontMatter: jest.Mock } {
  const vault: MockVault = {
    create: jest.fn().mockResolvedValue(existing ?? new TFile('a.md', 'notes/a.md')),
    modify: jest.fn().mockResolvedValue(undefined),
    createFolder: jest.fn().mockResolvedValue(undefined),
    read: jest.fn().mockResolvedValue('line one\nline two\nline three'),
    getAbstractFileByPath: jest.fn().mockReturnValue(existing),
  };
  const processFrontMatter = jest.fn(async (_file: unknown, mutate: (fm: Record<string, unknown>) => void) => {
    mutate(frontmatter);
  });
  const app = { vault, fileManager: { processFrontMatter } };
  return { app, vault, processFrontMatter };
}

function assertNoWrites(vault: MockVault): void {
  expect(vault.create).not.toHaveBeenCalled();
  expect(vault.modify).not.toHaveBeenCalled();
  expect(vault.createFolder).not.toHaveBeenCalled();
}

describe('WriteTool confinement', () => {
  it.each(ESCAPING)('rejects escaping path %s with no write', async (path) => {
    const { app, vault } = makeApp();
    const result = await new WriteTool(app).execute({ path, content: 'PWNED' } as any);
    expect(result.success).toBe(false);
    assertNoWrites(vault);
  });

  it('creates a normal vault-relative file', async () => {
    const { app, vault } = makeApp();
    const result = await new WriteTool(app).execute({ path: 'notes/a.md', content: 'hello' } as any);
    expect(result.success).toBe(true);
    expect(vault.create).toHaveBeenCalledWith('notes/a.md', 'hello');
  });

  it('still accepts a legit name containing ".."', async () => {
    const { app, vault } = makeApp();
    const result = await new WriteTool(app).execute({ path: 'notes/a..b.md', content: 'x' } as any);
    expect(result.success).toBe(true);
    expect(vault.create).toHaveBeenCalledWith('notes/a..b.md', 'x');
  });
});

describe('ContentOperations.createContent confinement', () => {
  it.each(ESCAPING)('throws for escaping path %s with no write', async (path) => {
    const { app, vault } = makeApp();
    await expect(ContentOperations.createContent(app, path, 'PWNED')).rejects.toThrow();
    assertNoWrites(vault);
  });

  it('writes a normal path', async () => {
    const { app, vault } = makeApp();
    await ContentOperations.createContent(app, 'notes/a.md', 'hi');
    expect(vault.create).toHaveBeenCalledWith('notes/a.md', 'hi');
  });
});

describe('InsertTool confinement', () => {
  it.each(ESCAPING)('rejects escaping path %s with no write', async (path) => {
    const { app, vault } = makeApp();
    const result = await new InsertTool(app).execute({ path, content: 'x', startLine: 1 } as any);
    expect(result.success).toBe(false);
    assertNoWrites(vault);
  });

  it('inserts into a normal existing file', async () => {
    const file = new TFile('a.md', 'notes/a.md');
    const { app, vault } = makeApp(file);
    const result = await new InsertTool(app).execute({ path: 'notes/a.md', content: 'x', startLine: 1 } as any);
    expect(result.success).toBe(true);
    expect(vault.modify).toHaveBeenCalled();
  });
});

describe('ReplaceTool confinement', () => {
  it.each(ESCAPING)('rejects escaping path %s with no write', async (path) => {
    const { app, vault } = makeApp();
    const result = await new ReplaceTool(app).execute({ path, start: 'line one', end: 'line three', content: '' } as any);
    expect(result.success).toBe(false);
    assertNoWrites(vault);
  });

  it('replaces a range in a normal existing file', async () => {
    const file = new TFile('a.md', 'notes/a.md');
    const { app, vault } = makeApp(file);
    const result = await new ReplaceTool(app).execute({ path: 'notes/a.md', start: 'line one', end: 'line three', content: 'ONE' } as any);
    expect(result.success).toBe(true);
    expect(vault.modify).toHaveBeenCalled();
  });
});

describe('RemovePropertyTool confinement', () => {
  it.each(ESCAPING)('rejects escaping path %s with no frontmatter write', async (path) => {
    const { app, processFrontMatter } = makeApp(undefined, { tags: ['x'] });
    const result = await new RemovePropertyTool(app).execute({ path, property: 'tags' } as any);
    expect(result.success).toBe(false);
    expect(processFrontMatter).not.toHaveBeenCalled();
  });

  it('removes a property from a normal existing file', async () => {
    const file = new TFile('a.md', 'notes/a.md');
    const frontmatter: Record<string, unknown> = { tags: ['x'], status: 'draft' };
    const { app, processFrontMatter } = makeApp(file, frontmatter);
    const result = await new RemovePropertyTool(app).execute({ path: 'notes/a.md', property: 'tags' } as any);
    expect(result.success).toBe(true);
    expect(processFrontMatter).toHaveBeenCalled();
    // The key is gone from the object Obsidian re-serializes, not set to null.
    expect('tags' in frontmatter).toBe(false);
    expect(frontmatter).toEqual({ status: 'draft' });
  });

  it('drops one list item and leaves the property in place', async () => {
    const file = new TFile('a.md', 'notes/a.md');
    const frontmatter: Record<string, unknown> = { tags: ['a', 'b'] };
    const { app } = makeApp(file, frontmatter);
    const result = await new RemovePropertyTool(app)
      .execute({ path: 'notes/a.md', property: 'tags', value: 'a' } as any);
    expect(result.success).toBe(true);
    expect(frontmatter).toEqual({ tags: ['b'] });
  });

  it('reports failure and leaves frontmatter untouched when the property is absent', async () => {
    const file = new TFile('a.md', 'notes/a.md');
    const frontmatter: Record<string, unknown> = { status: 'draft' };
    const { app } = makeApp(file, frontmatter);
    const result = await new RemovePropertyTool(app).execute({ path: 'notes/a.md', property: 'tag' } as any);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Properties present: status');
    expect(frontmatter).toEqual({ status: 'draft' });
  });

  it('rejects an empty property name before touching the file', async () => {
    const file = new TFile('a.md', 'notes/a.md');
    const { app, processFrontMatter } = makeApp(file, { tags: ['x'] });
    const result = await new RemovePropertyTool(app).execute({ path: 'notes/a.md', property: '  ' } as any);
    expect(result.success).toBe(false);
    expect(processFrontMatter).not.toHaveBeenCalled();
  });
});

describe('SetPropertyTool confinement', () => {
  it.each(ESCAPING)('rejects escaping path %s with no frontmatter write', async (path) => {
    const { app, processFrontMatter } = makeApp();
    const result = await new SetPropertyTool(app).execute({ path, property: 'tags', value: 'x' } as any);
    expect(result.success).toBe(false);
    expect(processFrontMatter).not.toHaveBeenCalled();
  });

  it('sets a property on a normal existing file', async () => {
    const file = new TFile('a.md', 'notes/a.md');
    const { app, processFrontMatter } = makeApp(file);
    const result = await new SetPropertyTool(app).execute({ path: 'notes/a.md', property: 'tags', value: 'x' } as any);
    expect(result.success).toBe(true);
    expect(processFrontMatter).toHaveBeenCalled();
  });
});
