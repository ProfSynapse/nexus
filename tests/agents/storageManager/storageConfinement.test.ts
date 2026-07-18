/**
 * Regression tests: the storageManager write boundary confines caller paths to
 * the vault. `../` and absolute paths must be rejected WITHOUT any vault mutation
 * (create/createFolder/rename), while normal operations still succeed. Move/copy
 * validate BOTH source and target.
 * See docs/plans/vault-path-confinement-plan.md.
 */

import { TFile } from 'obsidian';
import { FileOperations } from '@/agents/storageManager/utils/FileOperations';
import { CreateFolderTool } from '@/agents/storageManager/tools/createFolder';
import { MoveTool } from '@/agents/storageManager/tools/move';

// A POSIX leading slash (/tmp/ESCAPE) is stripped to vault-relative (backward-compat), not an escape.
const ESCAPING = ['../../../../tmp/ESCAPE', '~/ESCAPE', '..\\..\\ESCAPE'];

interface MockVault {
  create: jest.Mock;
  createFolder: jest.Mock;
  getAbstractFileByPath: jest.Mock;
  read: jest.Mock;
}

function makeApp(files: Record<string, TFile> = {}): { app: any; vault: MockVault; renameFile: jest.Mock; trashFile: jest.Mock } {
  const vault: MockVault = {
    create: jest.fn().mockResolvedValue(new TFile()),
    createFolder: jest.fn().mockResolvedValue(undefined),
    getAbstractFileByPath: jest.fn((p: string) => files[p] ?? null),
    read: jest.fn().mockResolvedValue('body'),
  };
  const renameFile = jest.fn().mockResolvedValue(undefined);
  const trashFile = jest.fn().mockResolvedValue(undefined);
  const app = { vault, fileManager: { renameFile, trashFile } };
  return { app, vault, renameFile, trashFile };
}

describe('FileOperations.createFolder confinement', () => {
  it.each(ESCAPING)('throws for escaping path %s with no createFolder', async (path) => {
    const { app, vault } = makeApp();
    await expect(FileOperations.createFolder(app, path)).rejects.toThrow();
    expect(vault.createFolder).not.toHaveBeenCalled();
  });

  it('creates a normal folder', async () => {
    const { app, vault } = makeApp();
    await FileOperations.createFolder(app, 'projects/2024');
    expect(vault.createFolder).toHaveBeenCalledWith('projects/2024');
  });
});

describe('FileOperations.moveNote confinement (source AND target)', () => {
  it('rejects an escaping TARGET with a valid source and never renames', async () => {
    const source = new TFile('a.md', 'notes/a.md');
    const { app, renameFile } = makeApp({ 'notes/a.md': source });
    await expect(FileOperations.moveNote(app, 'notes/a.md', '../../../../tmp/ESCAPE.md')).rejects.toThrow();
    expect(renameFile).not.toHaveBeenCalled();
  });

  it('rejects an escaping SOURCE and never renames', async () => {
    const { app, renameFile } = makeApp();
    await expect(FileOperations.moveNote(app, '../../../../tmp/ESCAPE.md', 'notes/b.md')).rejects.toThrow();
    expect(renameFile).not.toHaveBeenCalled();
  });

  it('moves a normal file', async () => {
    const source = new TFile('a.md', 'notes/a.md');
    const { app, renameFile } = makeApp({ 'notes/a.md': source });
    await FileOperations.moveNote(app, 'notes/a.md', 'archive/a.md');
    expect(renameFile).toHaveBeenCalledWith(source, 'archive/a.md');
  });
});

describe('FileOperations.duplicateNote confinement (source AND target)', () => {
  it('rejects an escaping TARGET and never creates', async () => {
    const source = new TFile('a.md', 'notes/a.md');
    const { app, vault } = makeApp({ 'notes/a.md': source });
    await expect(
      FileOperations.duplicateNote(app, 'notes/a.md', '../../../../tmp/ESCAPE.md', false, false)
    ).rejects.toThrow();
    expect(vault.create).not.toHaveBeenCalled();
  });
});

describe('CreateFolderTool confinement', () => {
  it.each(ESCAPING)('rejects escaping path %s with no createFolder', async (path) => {
    const { app, vault } = makeApp();
    const result = await new CreateFolderTool(app).execute({ path } as any);
    expect(result.success).toBe(false);
    expect(vault.createFolder).not.toHaveBeenCalled();
  });

  it('creates a normal folder', async () => {
    const { app, vault } = makeApp();
    const result = await new CreateFolderTool(app).execute({ path: 'projects/new' } as any);
    expect(result.success).toBe(true);
    expect(vault.createFolder).toHaveBeenCalledWith('projects/new');
  });
});

describe('MoveTool confinement', () => {
  it('rejects an escaping TARGET (valid source) and never renames', async () => {
    const source = new TFile('a.md', 'notes/a.md');
    const { app, renameFile } = makeApp({ 'notes/a.md': source });
    const result = await new MoveTool(app).execute({ path: 'notes/a.md', newPath: '../../../../tmp/ESCAPE.md' } as any);
    expect(result.success).toBe(false);
    expect(renameFile).not.toHaveBeenCalled();
  });

  it('moves a normal file', async () => {
    const source = new TFile('a.md', 'notes/a.md');
    const { app, renameFile } = makeApp({ 'notes/a.md': source });
    const result = await new MoveTool(app).execute({ path: 'notes/a.md', newPath: 'archive/a.md' } as any);
    expect(result.success).toBe(true);
    expect(renameFile).toHaveBeenCalledWith(source, 'archive/a.md');
  });
});
