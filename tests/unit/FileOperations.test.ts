import { App, TFile, TFolder } from 'obsidian';
import { FileOperations } from '../../src/agents/storageManager/utils/FileOperations';

function makeApp(filesByPath: Map<string, TFile | TFolder>): {
  app: App;
  renameFile: jest.Mock<Promise<void>, [TFile | TFolder, string]>;
  vaultRename: jest.Mock<Promise<void>, [TFile | TFolder, string]>;
} {
  const renameFile = jest.fn<Promise<void>, [TFile | TFolder, string]>().mockResolvedValue(undefined);
  const vaultRename = jest.fn<Promise<void>, [TFile | TFolder, string]>().mockResolvedValue(undefined);

  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => filesByPath.get(path) ?? null,
      rename: vaultRename,
    },
    fileManager: {
      renameFile,
      trashFile: jest.fn<Promise<void>, [TFile | TFolder]>().mockResolvedValue(undefined),
    },
  } as unknown as App;

  return { app, renameFile, vaultRename };
}

describe('FileOperations move helpers', () => {
  it('moves notes through FileManager so Obsidian can update links', async () => {
    const file = new TFile('Old.md', 'Old.md');
    const { app, renameFile, vaultRename } = makeApp(new Map([['Old.md', file]]));

    await FileOperations.moveNote(app, 'Old.md', 'New.md');

    expect(renameFile).toHaveBeenCalledWith(file, 'New.md');
    expect(vaultRename).not.toHaveBeenCalled();
  });

  it('moves folders through FileManager so Obsidian can update links', async () => {
    const folder = new TFolder('Old folder');
    const { app, renameFile, vaultRename } = makeApp(new Map([['Old folder', folder]]));

    await FileOperations.moveFolder(app, 'Old folder', 'New folder');

    expect(renameFile).toHaveBeenCalledWith(folder, 'New folder');
    expect(vaultRename).not.toHaveBeenCalled();
  });
});
