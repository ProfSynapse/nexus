/**
 * Core Obsidian API mocks: Editor, files, App, Vault, Workspace, Platform.
 */

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

// EventRef mock
export type EventRef = Record<string, never>;

// MarkdownFileInfo mock (used in editorCallback context)
export interface MarkdownFileInfo {
  file: TFile | null;
}

// Helper to create mock DOM elements (used internally by components)
export function createMockElement(tagName: string): HTMLElement {
  return {
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
    createEl: jest.fn((_tag: string, _opts?: { cls?: string; text?: string; attr?: Record<string, string> }) => createMockElement('div')),
    createDiv: jest.fn((_cls?: string | Record<string, unknown>) => createMockElement('div')),
    createSpan: jest.fn((_opts?: Record<string, unknown>) => createMockElement('span')),
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
}
