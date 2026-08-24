import type { App } from 'obsidian';
import { WriteTool } from '../../src/agents/contentManager/tools/write';
import { ReplaceTool } from '../../src/agents/contentManager/tools/replace';
import { InsertTool } from '../../src/agents/contentManager/tools/insert';
import { SetPropertyTool } from '../../src/agents/contentManager/tools/setProperty';
import { MoveTool } from '../../src/agents/storageManager/tools/move';
import { CopyTool } from '../../src/agents/storageManager/tools/copy';
import { ArchiveTool } from '../../src/agents/storageManager/tools/archive';
import { WriteCanvasTool } from '../../src/agents/canvasManager/tools/write';
import { UpdateCanvasTool } from '../../src/agents/canvasManager/tools/update';

function appWithPath(existingPath?: string): App {
  return {
    vault: {
      getAbstractFileByPath: jest.fn((path: string) => path === existingPath ? { path } : null),
    },
  } as unknown as App;
}

describe('Tool mutation intents', () => {
  it('distinguishes content write create from overwrite targets', async () => {
    const create = new WriteTool(appWithPath());
    const modify = new WriteTool(appWithPath('notes/existing.md'));

    await expect(create.getMutationIntent({
      path: 'notes/new.md', content: 'new'
    })).resolves.toEqual({ kind: 'create', path: 'notes/new.md' });
    await expect(modify.getMutationIntent({
      path: 'notes/existing.md', content: 'replacement', overwrite: true
    })).resolves.toEqual({ kind: 'modify', path: 'notes/existing.md' });
  });

  it('resolves every supported content mutation to a confined modify path', async () => {
    const app = appWithPath();
    await expect(new ReplaceTool(app).getMutationIntent({
      path: 'notes/a.md', start: 'a', end: 'a', content: 'b'
    })).resolves.toEqual({ kind: 'modify', path: 'notes/a.md' });
    await expect(new InsertTool(app).getMutationIntent({
      path: 'notes/a.md', content: 'b', startLine: -1
    })).resolves.toEqual({ kind: 'modify', path: 'notes/a.md' });
    await expect(new SetPropertyTool(app).getMutationIntent({
      path: 'notes/a.md', property: 'status', value: 'done'
    })).resolves.toEqual({ kind: 'modify', path: 'notes/a.md' });
  });

  it('declares exact move, copy, and archive source/destination paths', async () => {
    const app = appWithPath();
    await expect(new MoveTool(app).getMutationIntent({
      path: 'from/a.md', newPath: 'to/a.md'
    })).resolves.toEqual({ kind: 'move', from: 'from/a.md', to: 'to/a.md' });
    await expect(new CopyTool(app).getMutationIntent({
      path: 'from/a.md', newPath: 'to/a.md'
    })).resolves.toEqual({ kind: 'copy', from: 'from/a.md', to: 'to/a.md' });

    const archiveIntent = await new ArchiveTool(app).getMutationIntent({ path: 'notes/a.md' });
    expect(archiveIntent).toEqual({
      kind: 'archive',
      from: 'notes/a.md',
      to: expect.stringMatching(/^\.archive\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\/notes\/a\.md$/),
    });
  });

  it('normalizes canvas extensions before declaring create or modify', async () => {
    const app = appWithPath();
    await expect(new WriteCanvasTool(app).getMutationIntent({ path: 'boards/new' }))
      .resolves.toEqual({ kind: 'create', path: 'boards/new.canvas' });
    await expect(new UpdateCanvasTool(app).getMutationIntent({ path: 'boards/existing.canvas' }))
      .resolves.toEqual({ kind: 'modify', path: 'boards/existing.canvas' });
  });

  it('rejects out-of-vault targets before returning an intent', async () => {
    const tool = new MoveTool(appWithPath());
    await expect(Promise.resolve().then(() => tool.getMutationIntent({
      path: '../outside.md', newPath: 'inside.md'
    }))).rejects.toThrow(/cannot contain "\.\."/);
  });
});
