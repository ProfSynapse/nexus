import { App, Editor, MarkdownView, TFile } from 'obsidian';
import { ReadAloudCommandManager } from '../../src/core/commands/ReadAloudCommandManager';
import { ReadAloudSaveService } from '../../src/services/readAloud/ReadAloudSaveService';

// Mock the backend save service — frontend only CALLS its two pinned methods
// (S2 boundary), so we assert the calls without exercising backend internals.
jest.mock('../../src/services/readAloud/ReadAloudSaveService');

const MockedSaveService = ReadAloudSaveService as jest.MockedClass<typeof ReadAloudSaveService>;

interface CapturedCommand {
  id: string;
  name: string;
  checkCallback?: (checking: boolean) => boolean;
  editorCheckCallback?: (checking: boolean, editor: Editor, ctx: { file: TFile | null }) => boolean;
}

interface CapturedMenuItem {
  title: string;
  icon: string;
  onClick: () => void;
}

class FakeMenu {
  items: CapturedMenuItem[] = [];

  addItem(cb: (item: MenuItemBuilder) => void): this {
    const builder = new MenuItemBuilder();
    cb(builder);
    this.items.push({ title: builder.title, icon: builder.icon, onClick: builder.clickHandler });
    return this;
  }
}

class MenuItemBuilder {
  title = '';
  icon = '';
  clickHandler: () => void = () => undefined;

  setTitle(title: string): this { this.title = title; return this; }
  setIcon(icon: string): this { this.icon = icon; return this; }
  onClick(handler: () => void): this { this.clickHandler = handler; return this; }
}

/**
 * Build a plugin/app harness that captures registered commands and the
 * editor-menu / file-menu callbacks so a test can fire them directly.
 */
function buildHarness(activeFile: TFile | null = new TFile('My Note.md', 'My Note.md')) {
  const commands: CapturedCommand[] = [];
  const menuCallbacks: Record<string, (...args: unknown[]) => void> = {};

  const app = new App();
  app.workspace.getActiveViewOfType = (() => {
    return activeFile ? ({ file: activeFile } as MarkdownView) : null;
  }) as App['workspace']['getActiveViewOfType'];
  app.workspace.on = ((name: string, cb: (...args: unknown[]) => void) => {
    menuCallbacks[name] = cb;
    return { id: name };
  }) as unknown as App['workspace']['on'];

  const plugin = {
    addCommand: (command: CapturedCommand) => { commands.push(command); },
    registerEvent: () => undefined,
    settings: {
      settings: {
        llmProviders: { providers: {} },
        apps: { apps: {} },
        storage: { rootPath: 'Nexus', audioSubfolder: 'audio', maxShardBytes: 1 }
      }
    }
  };

  const manager = new ReadAloudCommandManager({
    plugin: plugin as never,
    app
  });
  manager.registerCommands();

  return { manager, commands, menuCallbacks, app, activeFile };
}

describe('ReadAloudCommandManager — save as audio', () => {
  beforeEach(() => {
    MockedSaveService.mockClear();
    MockedSaveService.prototype.saveSelectionAsAudio = jest.fn().mockResolvedValue(undefined);
    MockedSaveService.prototype.saveNoteAsAudio = jest.fn().mockResolvedValue(undefined);
  });

  it('registers both save commands', () => {
    const { commands } = buildHarness();
    const ids = commands.map(c => c.id);
    expect(ids).toContain('save-active-note-as-audio');
    expect(ids).toContain('save-selection-as-audio');
  });

  it('"Save note as audio" command is gated on an active file', () => {
    const withFile = buildHarness(new TFile('Note.md', 'Note.md'));
    const cmd = withFile.commands.find(c => c.id === 'save-active-note-as-audio');
    expect(cmd?.checkCallback?.(true)).toBe(true);

    const noFile = buildHarness(null);
    const cmdNoFile = noFile.commands.find(c => c.id === 'save-active-note-as-audio');
    expect(cmdNoFile?.checkCallback?.(true)).toBe(false);
  });

  it('"Save note as audio" calls backend saveNoteAsAudio when executed', async () => {
    const file = new TFile('Note.md', 'Note.md');
    const { commands } = buildHarness(file);
    const cmd = commands.find(c => c.id === 'save-active-note-as-audio');

    cmd?.checkCallback?.(false);
    await Promise.resolve();

    expect(MockedSaveService.prototype.saveNoteAsAudio).toHaveBeenCalledWith(file);
  });

  it('"Save selection as audio" command requires a selection AND a file', () => {
    const { commands } = buildHarness();
    const cmd = commands.find(c => c.id === 'save-selection-as-audio');
    const file = new TFile('Note.md', 'Note.md');

    const noSelection = new Editor();
    expect(cmd?.editorCheckCallback?.(true, noSelection, { file })).toBe(false);

    const withSelection = new Editor();
    withSelection.setSelection('hello world');
    expect(cmd?.editorCheckCallback?.(true, withSelection, { file })).toBe(true);

    expect(cmd?.editorCheckCallback?.(true, withSelection, { file: null })).toBe(false);
  });

  it('"Save selection as audio" calls backend saveSelectionAsAudio when executed', async () => {
    const { commands } = buildHarness();
    const cmd = commands.find(c => c.id === 'save-selection-as-audio');
    const file = new TFile('Note.md', 'Note.md');
    const editor = new Editor();
    editor.setSelection('read this');

    cmd?.editorCheckCallback?.(false, editor, { file });
    await Promise.resolve();

    expect(MockedSaveService.prototype.saveSelectionAsAudio).toHaveBeenCalledWith(editor, file);
  });

  it('editor context menu offers "Save selection as audio" only on a md file with a selection', () => {
    const { menuCallbacks } = buildHarness();
    const editor = new Editor();
    editor.setSelection('some text');
    const file = new TFile('Note.md', 'Note.md');

    const menu = new FakeMenu();
    menuCallbacks['editor-menu'](menu, editor, { file });

    const titles = menu.items.map(i => i.title);
    expect(titles).toContain('Save selection as audio');
  });

  it('file menu offers "Save note as audio" on a markdown file', () => {
    const { menuCallbacks } = buildHarness();
    const file = new TFile('Note.md', 'Note.md');

    const menu = new FakeMenu();
    menuCallbacks['file-menu'](menu, file, 'more-options');

    const titles = menu.items.map(i => i.title);
    expect(titles).toContain('Save note as audio');
  });
});
