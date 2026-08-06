/**
 * Core Obsidian API mocks: Editor, files, App, Vault, Workspace, Platform.
 */
import { parse, stringify } from 'yaml';

// EditorPosition type
export interface EditorPosition {
  line: number;
  ch: number;
}

// Editor mock
export class Editor {
  private selection = '';
  private cursorFrom: EditorPosition = { line: 0, ch: 0 };
  private cursorTo: EditorPosition = { line: 0, ch: 0 };
  private content = '';
  private hasSelection = false;

  // Methods to set up mock state
  setSelection(text: string, from?: EditorPosition, to?: EditorPosition): void {
    this.selection = text;
    this.hasSelection = text.length > 0;
    if (from) this.cursorFrom = from;
    if (to) this.cursorTo = to;
  }

  setContent(content: string): void {
    this.content = content;
  }

  // Obsidian Editor API methods
  somethingSelected(): boolean {
    return this.hasSelection;
  }

  getSelection(): string {
    return this.selection;
  }

  getCursor(which?: 'from' | 'to' | 'head' | 'anchor'): EditorPosition {
    if (which === 'to') return this.cursorTo;
    return this.cursorFrom;
  }

  replaceRange(text: string, from: EditorPosition, to?: EditorPosition): void {
    void text;
    void from;
    void to;
  }

  getValue(): string {
    return this.content;
  }

  setValue(content: string): void {
    this.content = content;
  }
}

// TFile mock
export class TFile {
  name: string;
  path: string;
  basename: string;
  extension: string;

  constructor(name = 'test.md', path = 'test.md') {
    this.name = name;
    this.path = path;
    this.basename = name.replace(/\.[^/.]+$/, '');
    this.extension = name.split('.').pop() || '';
  }
}

// TFolder mock
export class TFolder {
  path: string;
  name: string;
  children: unknown[] = [];

  constructor(path: string) {
    this.path = path;
    this.name = path.split('/').pop() || '';
  }
}

// Vault mock
export class Vault {
  async read(): Promise<string> {
    return '';
  }

  async cachedRead(): Promise<string> {
    return '';
  }
}

// Workspace mock
export class Workspace {
  activeLeaf: WorkspaceLeaf | null = null;
  activeEditor: { editor: Editor } | null = null;

  setActiveEditor(editor: Editor): void {
    this.activeEditor = { editor };
  }

  getActiveViewOfType<T>(): T | null {
    return null;
  }
}

// WorkspaceLeaf mock
export class WorkspaceLeaf {
  view: MarkdownView;

  constructor(view?: MarkdownView) {
    this.view = view || new MarkdownView();
  }
}

// MarkdownView mock
export class MarkdownView {
  file: TFile | null;
  editor: Editor;

  constructor(file?: TFile) {
    this.file = file || new TFile();
    this.editor = new Editor();
  }
}

// App mock
export class App {
  vault: Vault;
  workspace: Workspace;

  constructor() {
    this.vault = new Vault();
    this.workspace = new Workspace();
  }
}

export const Platform = {
  isMobile: false,
  isDesktop: true,
  isIosApp: false,
  isAndroidApp: false,
  isMacOS: true,
  isWin: false,
  isLinux: false,
};

interface RequestUrlRequest {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  throw?: boolean;
}

interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
  arrayBuffer: ArrayBuffer;
}

type RequestUrlImpl = (request: RequestUrlRequest) => Promise<RequestUrlResponse>;

let requestUrlImpl: RequestUrlImpl = async () => ({
  status: 200,
  headers: {},
  text: '',
  json: {},
  arrayBuffer: new ArrayBuffer(0)
});

export function __setRequestUrlMock(mock: RequestUrlImpl): void {
  requestUrlImpl = mock;
}

export function requestUrl(request: RequestUrlRequest): Promise<RequestUrlResponse> {
  return requestUrlImpl(request);
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}

/**
 * Mock of Obsidian's `prepareFuzzySearch`.
 *
 * Mirrors the two properties production code actually depends on:
 *  - it matches a SUBSEQUENCE, so text sharing only scattered characters with
 *    the query still matches, and
 *  - the score is a small NEGATIVE number where closer to 0 is a better match.
 *
 * The magnitudes matter: real Obsidian returns single/low-double-digit
 * penalties even for weak scattered hits, which is why `1 + score/100`
 * compressed nearly every filename hit up near 0.95. Reproducing that scale
 * is the point of this mock.
 */
export function prepareFuzzySearch(query: string): (text: string) => { score: number } | null {
  const needle = query.toLowerCase().replace(/\s+/g, '');

  return (text: string) => {
    const haystack = text.toLowerCase();
    if (needle.length === 0) {
      return null;
    }

    let cursor = 0;
    let breaks = 0;

    for (const char of needle) {
      const found = haystack.indexOf(char, cursor);
      if (found === -1) {
        return null;
      }
      if (found !== cursor) {
        breaks++;
      }
      cursor = found + 1;
    }

    // The penalty is charged per DISCONTIGUITY and stays small, which is the
    // property that made #309 possible: even a badly scattered match returns a
    // single-digit penalty, so `1 + score/100` lands just under 1.0 rather than
    // degrading in proportion to how poor the match is.
    return { score: -Math.min(breaks, 8) };
  };
}

export function parseYaml(yaml: string): unknown {
  return parse(yaml);
}

export function stringifyYaml(obj: unknown): string {
  return stringify(obj);
}

// Events / EventRef mocks
export interface EventRef {
  name?: string;
  callback?: (...data: unknown[]) => unknown;
}

export class Events {
  private listeners = new Map<string, Set<(...data: unknown[]) => unknown>>();

  on(name: string, callback: (...data: unknown[]) => unknown): EventRef {
    const callbacks = this.listeners.get(name) ?? new Set<(...data: unknown[]) => unknown>();
    callbacks.add(callback);
    this.listeners.set(name, callbacks);
    return { name, callback };
  }

  offref(ref: EventRef): void {
    if (!ref.name || !ref.callback) {
      return;
    }
    this.listeners.get(ref.name)?.delete(ref.callback);
  }

  trigger(name: string, ...data: unknown[]): void {
    this.listeners.get(name)?.forEach(callback => {
      callback(...data);
    });
  }
}

// MarkdownFileInfo mock (used in editorCallback context)
export interface MarkdownFileInfo {
  file: TFile | null;
}

// Helper to create mock DOM elements (used internally by components)
export function createMockElement(tagName: string): HTMLElement {
  const el = {
    tagName: tagName.toUpperCase(),
    classList: {
      add: jest.fn(),
      remove: jest.fn(),
      toggle: jest.fn(),
      contains: jest.fn(() => false)
    },
    addClass: jest.fn(),
    removeClass: jest.fn(),
    hasClass: jest.fn(() => false),
    toggleClass: jest.fn(),
    setText: jest.fn(),
    createEl: jest.fn((tag: string, _opts?: { cls?: string; text?: string; attr?: Record<string, string> }) => createMockElement(typeof tag === 'string' ? tag : 'div')),
    // Obsidian's createDiv/createSpan are createEl('div'/'span', opts). Delegate to
    // createEl so tests asserting createEl(...) transparently capture these calls
    // (the prefer-create-el lint rewrites createEl('div', o) → createDiv(o)).
    createDiv: jest.fn(),
    createSpan: jest.fn(),
    empty: jest.fn(),
    remove: jest.fn(),
    appendChild: jest.fn(),
    removeChild: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    setAttribute: jest.fn(),
    getAttribute: jest.fn(),
    removeAttribute: jest.fn(),
    querySelector: jest.fn(),
    querySelectorAll: jest.fn(() => []),
    parentElement: null,
    style: {},
    textContent: '',
    innerHTML: '',
    value: '',
    rows: 0,
    scrollTop: 0,
    scrollHeight: 0,
    focus: jest.fn()
  } as unknown as HTMLElement;

  const normalizeOpts = (o?: string | Record<string, unknown>) =>
    typeof o === 'string' ? { cls: o } : o;
  (el.createDiv as jest.Mock).mockImplementation((o?: string | Record<string, unknown>) =>
    (el.createEl as jest.Mock)('div', normalizeOpts(o)));
  (el.createSpan as jest.Mock).mockImplementation((o?: string | Record<string, unknown>) =>
    (el.createEl as jest.Mock)('span', normalizeOpts(o)));

  return el;
}
