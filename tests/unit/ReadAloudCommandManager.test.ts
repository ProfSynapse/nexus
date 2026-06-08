import { App, Editor, MarkdownView, TFile } from 'obsidian';
import { ReadAloudCommandManager } from '../../src/core/commands/ReadAloudCommandManager';
import { ReadAloudService } from '../../src/services/readAloud/ReadAloudService';
import { SavePromptModal } from '../../src/ui/readAloud/SavePromptModal';
import { ReadAloudProgressModal } from '../../src/ui/readAloud/ReadAloudProgressModal';

// Mock the backend session API and both modals — frontend only DRIVES them
// (S2 boundary), so we assert the wiring without exercising backend/modal DOM.
jest.mock('../../src/services/readAloud/ReadAloudService');
jest.mock('../../src/services/readAloud/ReadAloudSaveService');
jest.mock('../../src/ui/readAloud/SavePromptModal');
jest.mock('../../src/ui/readAloud/ReadAloudProgressModal');

const MockedReadAloudService = ReadAloudService as jest.MockedClass<typeof ReadAloudService>;
const MockedSavePromptModal = SavePromptModal as jest.MockedClass<typeof SavePromptModal>;
const MockedProgressModal = ReadAloudProgressModal as jest.MockedClass<typeof ReadAloudProgressModal>;

interface CapturedCommand {
  id: string;
  name: string;
  checkCallback?: (checking: boolean) => boolean;
  editorCheckCallback?: (checking: boolean, editor: Editor, ctx: { file: TFile | null }) => boolean;
}

class FakeMenu {
  items: { title: string; onClick: () => void }[] = [];
  addItem(cb: (item: MenuItemBuilder) => void): this {
    const builder = new MenuItemBuilder();
    cb(builder);
    this.items.push({ title: builder.title, onClick: builder.clickHandler });
    return this;
  }
}

class MenuItemBuilder {
  title = '';
  clickHandler: () => void = () => undefined;
  setTitle(title: string): this { this.title = title; return this; }
  setIcon(): this { return this; }
  onClick(handler: () => void): this { this.clickHandler = handler; return this; }
}

let startSessionSpy: jest.Mock;
let sessionCompleted: Promise<{ savedPath?: string }>;

function buildHarness(activeFile: TFile | null = new TFile('My Note.md', 'My Note.md')) {
  const commands: CapturedCommand[] = [];
  const menuCallbacks: Record<string, (...args: unknown[]) => void> = {};

  const app = new App();
  app.workspace.getActiveViewOfType = (() =>
    activeFile ? ({ file: activeFile } as MarkdownView) : null
  ) as App['workspace']['getActiveViewOfType'];
  app.workspace.on = ((name: string, cb: (...args: unknown[]) => void) => {
    menuCallbacks[name] = cb;
    return { id: name };
  }) as unknown as App['workspace']['on'];
  app.vault.cachedRead = (async () => 'note body text') as App['vault']['cachedRead'];

  const plugin = {
    addCommand: (command: CapturedCommand) => { commands.push(command); },
    registerEvent: () => undefined,
    settings: { settings: { llmProviders: { providers: {} }, apps: { apps: {} }, storage: {} } }
  };

  const manager = new ReadAloudCommandManager({ plugin: plugin as never, app });
  manager.registerCommands();
  return { manager, commands, menuCallbacks };
}

/** Drive the SavePromptModal mock to invoke its callback with a given choice. */
function resolveSavePrompt(choice: 'save' | 'read' | 'cancel'): void {
  const lastCall = MockedSavePromptModal.mock.calls[MockedSavePromptModal.mock.calls.length - 1];
  const onChoose = lastCall[1] as (c: 'save' | 'read' | 'cancel') => void;
  onChoose(choice);
}

describe('ReadAloudCommandManager — v2 unified read-aloud', () => {
  beforeEach(() => {
    MockedReadAloudService.mockClear();
    MockedSavePromptModal.mockClear();
    MockedProgressModal.mockClear();

    sessionCompleted = Promise.resolve({});
    startSessionSpy = jest.fn(() => ({
      onProgress: jest.fn(),
      stopPlayback: jest.fn(),
      completed: sessionCompleted
    }));
    MockedReadAloudService.prototype.startReadAloudSession = startSessionSpy as never;
    MockedReadAloudService.prototype.isPlaying = jest.fn(() => false);
    MockedReadAloudService.prototype.stop = jest.fn();

    MockedSavePromptModal.prototype.open = jest.fn();
    MockedProgressModal.prototype.open = jest.fn();
    MockedProgressModal.prototype.setProgress = jest.fn();
    MockedProgressModal.prototype.finish = jest.fn();
  });

  it('registers the unified read-aloud commands and NOT the v1 save commands', () => {
    const { commands } = buildHarness();
    const ids = commands.map(c => c.id);
    expect(ids).toContain('read-active-note-aloud');
    expect(ids).toContain('read-selection-aloud');
    expect(ids).toContain('stop-read-aloud');
    // v1 commands removed
    expect(ids).not.toContain('save-active-note-as-audio');
    expect(ids).not.toContain('save-selection-as-audio');
  });

  it('editor menu offers ONE "Read selection aloud" entry (no separate save item)', () => {
    const { menuCallbacks } = buildHarness();
    const editor = new Editor();
    editor.setSelection('hello');
    const menu = new FakeMenu();
    menuCallbacks['editor-menu'](menu, editor, { file: new TFile('Note.md', 'Note.md') });

    const titles = menu.items.map(i => i.title);
    expect(titles).toEqual(['Read selection aloud']);
    expect(titles).not.toContain('Save selection as audio');
  });

  it('file menu offers ONE "Read note aloud" entry (no separate save item)', () => {
    const { menuCallbacks } = buildHarness();
    const menu = new FakeMenu();
    menuCallbacks['file-menu'](menu, new TFile('Note.md', 'Note.md'), 'more-options');

    const titles = menu.items.map(i => i.title);
    expect(titles).toEqual(['Read note aloud']);
    expect(titles).not.toContain('Save note as audio');
  });

  it('invoking read-aloud opens the SavePromptModal', () => {
    const { commands } = buildHarness();
    commands.find(c => c.id === 'read-active-note-aloud')?.checkCallback?.(false);
    expect(MockedSavePromptModal).toHaveBeenCalledTimes(1);
    expect(MockedSavePromptModal.prototype.open).toHaveBeenCalled();
  });

  it('choosing "Just read" starts a session with save=false', async () => {
    const { commands } = buildHarness();
    commands.find(c => c.id === 'read-active-note-aloud')?.checkCallback?.(false);
    resolveSavePrompt('read');
    await Promise.resolve();
    await Promise.resolve();

    expect(startSessionSpy).toHaveBeenCalledTimes(1);
    expect(startSessionSpy.mock.calls[0][0]).toMatchObject({ mode: 'note', save: false });
    expect(startSessionSpy.mock.calls[0][0].saveService).toBeUndefined();
  });

  it('choosing "Save & read" starts a session with save=true and a saveService', async () => {
    const { commands } = buildHarness();
    const editor = new Editor();
    editor.setSelection('read this selection');
    const cmd = commands.find(c => c.id === 'read-selection-aloud');
    cmd?.editorCheckCallback?.(false, editor, { file: new TFile('Note.md', 'Note.md') });
    resolveSavePrompt('save');
    await Promise.resolve();
    await Promise.resolve();

    expect(startSessionSpy).toHaveBeenCalledTimes(1);
    const opts = startSessionSpy.mock.calls[0][0];
    expect(opts).toMatchObject({ mode: 'selection', save: true });
    expect(opts.saveService).toBeDefined();
    expect(opts.markdown).toBe('read this selection');
  });

  it('choosing "Cancel" starts no session', async () => {
    const { commands } = buildHarness();
    commands.find(c => c.id === 'read-active-note-aloud')?.checkCallback?.(false);
    resolveSavePrompt('cancel');
    await Promise.resolve();

    expect(startSessionSpy).not.toHaveBeenCalled();
    expect(MockedProgressModal).not.toHaveBeenCalled();
  });

  it('selection command is gated on a selection + file', () => {
    const { commands } = buildHarness();
    const cmd = commands.find(c => c.id === 'read-selection-aloud');
    const file = new TFile('Note.md', 'Note.md');

    const empty = new Editor();
    expect(cmd?.editorCheckCallback?.(true, empty, { file })).toBe(false);

    const withSel = new Editor();
    withSel.setSelection('x');
    expect(cmd?.editorCheckCallback?.(true, withSel, { file })).toBe(true);
    expect(cmd?.editorCheckCallback?.(true, withSel, { file: null })).toBe(false);
  });
});
