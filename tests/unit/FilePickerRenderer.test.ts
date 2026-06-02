/**
 * FilePickerRenderer Tests (Wave 3 PR4)
 *
 * PR4 ported the folder-tree shell to the v3.1 `.ws-tree-*` class family
 * (renamed from `.nexus-tree-*`). The LOAD-BEARING regression guard for this
 * PR: the file checkboxes were KEPT (they back a real `selectedFiles:Set<string>`
 * multi-select), unlike PR2's decorative task-completion checkbox which was
 * swept. This file asserts:
 *   1. The tree emits `.ws-tree` / `.ws-tree-row` (+ is-folder/is-file) /
 *      `.ws-tree-checkbox` / `.ws-tree-icon` / `.ws-tree-name` after the rename.
 *   2. `data-depth` is retained on rows.
 *   3. Checkbox toggle preserves `selectedFiles` (round-trip add/remove) — the
 *      regression guard that the checkboxes were NOT swept.
 *
 * Test strategy: a children-tracking mock element (the project runs jest in a
 * jsdom-less `node` testEnvironment) + a hand-built TFolder/TFile tree wired
 * into a stub App.vault that supplies getRoot()/getAbstractFileByPath().
 */

import { FilePickerRenderer } from '../../src/components/workspace/FilePickerRenderer';
import { App, TFile, TFolder, Component } from 'obsidian';

// ============================================================================
// Children-tracking mock element
// ============================================================================

interface MockElement {
  tagName: string;
  className: string;
  type?: string;
  checked?: boolean;
  textContent: string;
  dataset: Record<string, string>;
  _children: MockElement[];
  _attrs: Record<string, string>;
  _listeners: Record<string, Array<(e: unknown) => void>>;
  createEl: jest.Mock;
  createDiv: jest.Mock;
  createSpan: jest.Mock;
  addClass: jest.Mock;
  setAttribute: jest.Mock;
  addEventListener: jest.Mock;
  dispatchEvent: jest.Mock;
  empty: jest.Mock;
  remove: jest.Mock;
}

function createMockEl(cls = ''): MockElement {
  const el: MockElement = {
    tagName: 'DIV',
    className: cls,
    textContent: '',
    dataset: {},
    _children: [],
    _attrs: {},
    _listeners: {},
    addClass: jest.fn(),
    setAttribute: jest.fn((k: string, v: string) => { el._attrs[k] = v; }),
    addEventListener: jest.fn((type: string, handler: (e: unknown) => void) => {
      (el._listeners[type] ||= []).push(handler);
    }),
    dispatchEvent: jest.fn((evt: { type: string }) => {
      // Production change/click handlers call e.stopPropagation(); supply a
      // no-op so a plain {type} payload from a test can drive the handler.
      const payload = { stopPropagation: () => undefined, ...evt };
      (el._listeners[evt.type] || []).forEach(h => h(payload));
      return true;
    }),
    empty: jest.fn(() => { el._children = []; }),
    remove: jest.fn(),
    createEl: jest.fn((tag?: string, opts?: { cls?: string; text?: string; type?: string; attr?: Record<string, string> }) => {
      const child = createMockEl(opts?.cls || '');
      child.tagName = (tag || 'DIV').toUpperCase();
      if (opts?.text) child.textContent = opts.text;
      if (opts?.type) child.type = opts.type;
      if (opts?.attr) Object.assign(child._attrs, opts.attr);
      el._children.push(child);
      return child;
    }),
    createDiv: jest.fn((arg?: string | { cls?: string; text?: string }) => {
      const c = typeof arg === 'string' ? arg : arg?.cls || '';
      const child = createMockEl(c);
      if (typeof arg === 'object' && arg?.text) child.textContent = arg.text;
      el._children.push(child);
      return child;
    }),
    createSpan: jest.fn((opts?: { cls?: string; text?: string }) => {
      const child = createMockEl(opts?.cls || '');
      if (opts?.text) child.textContent = opts.text;
      el._children.push(child);
      return child;
    }),
  };
  return el;
}

/** Recursively flatten all descendant elements (incl. self). */
function flatten(el: MockElement): MockElement[] {
  return [el, ...el._children.flatMap(flatten)];
}

/** Collect every element whose class contains the given token. */
function byClass(root: MockElement, token: string): MockElement[] {
  return flatten(root).filter(e => e.className.split(/\s+/).includes(token));
}

// ============================================================================
// Vault tree fixture
// ============================================================================

function makeFile(path: string): TFile {
  const name = path.split('/').pop() || path;
  return new TFile(name, path);
}

function makeFolder(path: string, children: Array<TFile | TFolder>): TFolder {
  const folder = new TFolder(path);
  folder.children = children;
  return folder;
}

/**
 * Build a stub App with a vault tree:
 *   /
 *   ├── notes/        (folder)
 *   │   ├── alpha.md
 *   │   └── beta.md
 *   └── readme.md
 */
function makeAppWithTree(): { app: App; root: TFolder; alpha: TFile; beta: TFile } {
  const alpha = makeFile('notes/alpha.md');
  const beta = makeFile('notes/beta.md');
  const readme = makeFile('readme.md');
  const notes = makeFolder('notes', [alpha, beta]);
  const root = makeFolder('/', [notes, readme]);

  const app = new App();
  (app.vault as unknown as { getRoot: () => TFolder }).getRoot = () => root;
  (app.vault as unknown as { getAbstractFileByPath: (p: string) => unknown }).getAbstractFileByPath = (p: string) => {
    if (p === 'notes') return notes;
    if (p === 'notes/alpha.md') return alpha;
    if (p === 'notes/beta.md') return beta;
    if (p === 'readme.md') return readme;
    return null;
  };
  return { app, root, alpha, beta };
}

function renderPicker(opts: { initialSelection?: string; rootFolder?: string } = {}): {
  renderer: FilePickerRenderer;
  container: MockElement;
  onSelect: jest.Mock;
  onCancel: jest.Mock;
} {
  const { app } = makeAppWithTree();
  const onSelect = jest.fn();
  const onCancel = jest.fn();
  const component = new Component();
  const renderer = new FilePickerRenderer(
    app,
    onSelect,
    onCancel,
    opts.initialSelection,
    opts.rootFolder,
    'Select Files',
    component
  );
  const container = createMockEl('root');
  renderer.render(container as unknown as HTMLElement);
  return { renderer, container, onSelect, onCancel };
}

// ============================================================================
// Tests
// ============================================================================

describe('FilePickerRenderer (PR4 .ws-tree class rename + checkbox preservation)', () => {
  describe('class rename — emits .ws-tree-* (not .nexus-tree-*)', () => {
    it('creates a .ws-tree container', () => {
      const { container } = renderPicker();
      expect(byClass(container, 'ws-tree').length).toBe(1);
    });

    it('emits .ws-tree-row rows for the root children', () => {
      const { container } = renderPicker();
      // Root has a "notes" folder + a "readme.md" file = 2 top-level rows.
      expect(byClass(container, 'ws-tree-row').length).toBe(2);
    });

    it('tags folder rows with is-folder and file rows with is-file', () => {
      const { container } = renderPicker();
      expect(byClass(container, 'is-folder').length).toBe(1); // notes/
      expect(byClass(container, 'is-file').length).toBe(1);   // readme.md
    });

    it('emits .ws-tree-icon and .ws-tree-name spans on every row', () => {
      const { container } = renderPicker();
      // 2 rows × 1 icon + 1 name each.
      expect(byClass(container, 'ws-tree-icon').length).toBe(2);
      expect(byClass(container, 'ws-tree-name').length).toBe(2);
    });

    it('does NOT emit any legacy .nexus-tree-* classes', () => {
      const { container } = renderPicker();
      const legacy = flatten(container).filter(e =>
        /\bnexus-tree-/.test(e.className)
      );
      expect(legacy).toEqual([]);
    });
  });

  describe('checkbox — KEPT (load-bearing multi-select), not swept', () => {
    it('emits a .ws-tree-checkbox input on each file row', () => {
      const { container } = renderPicker();
      const checkboxes = byClass(container, 'ws-tree-checkbox');
      // Only the file row (readme.md) gets a checkbox; the folder row does not.
      expect(checkboxes.length).toBe(1);
      expect(checkboxes[0].type).toBe('checkbox');
    });

    it('reflects the initial selection as a checked checkbox', () => {
      const { container } = renderPicker({ initialSelection: 'readme.md' });
      const checkbox = byClass(container, 'ws-tree-checkbox')[0];
      expect(checkbox.checked).toBe(true);
    });

    it('leaves the checkbox unchecked when the file is not initially selected', () => {
      const { container } = renderPicker();
      const checkbox = byClass(container, 'ws-tree-checkbox')[0];
      expect(checkbox.checked).toBe(false);
    });
  });

  describe('selectedFiles round-trip (the regression guard)', () => {
    function fileCheckbox(container: MockElement): MockElement {
      return byClass(container, 'ws-tree-checkbox')[0];
    }

    it('adds the file path to selectedFiles when the checkbox is checked', () => {
      const { renderer, container } = renderPicker();
      expect(renderer.getSelectedPaths()).toEqual([]);

      const checkbox = fileCheckbox(container);
      checkbox.checked = true;
      checkbox.dispatchEvent({ type: 'change' });

      expect(renderer.getSelectedPaths()).toContain('readme.md');
    });

    it('removes the file path from selectedFiles when the checkbox is unchecked', () => {
      const { renderer, container } = renderPicker({ initialSelection: 'readme.md' });
      expect(renderer.getSelectedPaths()).toEqual(['readme.md']);

      const checkbox = fileCheckbox(container);
      checkbox.checked = false;
      checkbox.dispatchEvent({ type: 'change' });

      expect(renderer.getSelectedPaths()).toEqual([]);
    });

    it('full round-trip: select → deselect → reselect leaves a single entry', () => {
      const { renderer, container } = renderPicker();
      const checkbox = fileCheckbox(container);

      checkbox.checked = true;
      checkbox.dispatchEvent({ type: 'change' });
      checkbox.checked = false;
      checkbox.dispatchEvent({ type: 'change' });
      checkbox.checked = true;
      checkbox.dispatchEvent({ type: 'change' });

      expect(renderer.getSelectedPaths()).toEqual(['readme.md']);
    });

    it('getSelectedPath returns the first selected path (single-select compat)', () => {
      const { renderer, container } = renderPicker();
      const checkbox = fileCheckbox(container);
      checkbox.checked = true;
      checkbox.dispatchEvent({ type: 'change' });
      expect(renderer.getSelectedPath()).toBe('readme.md');
    });

    it('handleDone (Done button) calls onSelect with the first selected path', () => {
      const { renderer, container, onSelect, onCancel } = renderPicker();
      const checkbox = fileCheckbox(container);
      checkbox.checked = true;
      checkbox.dispatchEvent({ type: 'change' });

      // handleDone is private; reach it via the public render-wired Done button
      // by invoking the renderer's own handler through getSelectedPaths-backed
      // onSelect. Simulate Done directly.
      (renderer as unknown as { handleDone: () => void }).handleDone();
      expect(onSelect).toHaveBeenCalledWith('readme.md');
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('handleDone calls onCancel when nothing is selected', () => {
      const { renderer, onSelect, onCancel } = renderPicker();
      (renderer as unknown as { handleDone: () => void }).handleDone();
      expect(onSelect).not.toHaveBeenCalled();
      expect(onCancel).toHaveBeenCalled();
    });
  });

  describe('data-depth retention', () => {
    it('stamps data-depth=0 on top-level rows', () => {
      const { container } = renderPicker();
      const rows = byClass(container, 'ws-tree-row');
      for (const row of rows) {
        expect(row.dataset.depth).toBe('0');
      }
    });
  });

  describe('empty state', () => {
    it('renders the folder-not-found message when the root folder is missing', () => {
      const app = new App();
      (app.vault as unknown as { getRoot: () => TFolder | null }).getRoot = () => null;
      (app.vault as unknown as { getAbstractFileByPath: (p: string) => unknown }).getAbstractFileByPath = () => null;
      const renderer = new FilePickerRenderer(app, jest.fn(), jest.fn(), undefined, 'missing-folder', 'Select', new Component());
      const container = createMockEl('root');
      renderer.render(container as unknown as HTMLElement);
      const empty = byClass(container, 'nexus-file-picker-empty');
      expect(empty.length).toBe(1);
      expect(empty[0].textContent).toBe('Folder not found');
    });
  });
});
