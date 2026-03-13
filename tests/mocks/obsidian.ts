/**
 * Obsidian API Mocks
 *
 * Provides mock implementations of Obsidian classes and interfaces
 * for testing plugin components without requiring the full Obsidian environment.
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
    // Mock implementation - in real tests we verify this is called with correct args
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

type RequestUrlImpl = (request: any) => Promise<any>;

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

export function requestUrl(request: any): Promise<any> {
  return requestUrlImpl(request);
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

// Modal mock
export class Modal {
  app: App;
  contentEl: HTMLElement;
  containerEl: HTMLElement;
  scope: Scope;

  constructor(app: App) {
    this.app = app;
    // Create mock DOM elements
    this.contentEl = createMockElement('div');
    this.containerEl = createMockElement('div');
    this.scope = new Scope();
  }

  open(): void {
    // Mock implementation
  }

  close(): void {
    // Mock implementation
  }

  onOpen(): void {
    // Override in subclass
  }

  onClose(): void {
    // Override in subclass
  }
}

// Scope mock
export class Scope {
  register(): void {
    // Mock implementation
  }
}

// Setting mock
export class Setting {
  settingEl: HTMLElement;
  controlEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    this.settingEl = createMockElement('div');
    this.controlEl = createMockElement('div');
  }

  setClass(cls: string): this {
    return this;
  }

  setName(name: string): this {
    return this;
  }

  setDesc(desc: string): this {
    return this;
  }

  setTooltip(tooltip: string): this {
    return this;
  }

  addText(callback: (text: TextComponent) => void): this {
    callback(new TextComponent(this.settingEl));
    return this;
  }

  addTextArea(callback: (textarea: TextAreaComponent) => void): this {
    callback(new TextAreaComponent(this.settingEl));
    return this;
  }

  addDropdown(callback: (dropdown: DropdownComponent) => void): this {
    callback(new DropdownComponent(this.settingEl));
    return this;
  }

  addToggle(callback: (toggle: ToggleComponent) => void): this {
    callback(new ToggleComponent(this.settingEl));
    return this;
  }

  addButton(callback: (button: ButtonComponent) => void): this {
    callback(new ButtonComponent(this.settingEl));
    return this;
  }

  addSlider(callback: (slider: SliderComponent) => any): this {
    callback(new SliderComponent(this.settingEl));
    return this;
  }
}

// TextComponent mock
export class TextComponent {
  inputEl: HTMLInputElement;
  private value = '';
  private changeCallback?: (value: string) => void;

  constructor(containerEl: HTMLElement) {
    this.inputEl = createMockElement('input') as HTMLInputElement;
  }

  setPlaceholder(placeholder: string): this {
    return this;
  }

  setValue(value: string): this {
    this.value = value;
    return this;
  }

  getValue(): string {
    return this.value;
  }

  onChange(callback: (value: string) => void): this {
    this.changeCallback = callback;
    return this;
  }

  // Helper for tests to trigger change
  triggerChange(value: string): void {
    this.value = value;
    this.changeCallback?.(value);
  }
}

// TextAreaComponent mock
export class TextAreaComponent {
  inputEl: HTMLTextAreaElement;
  private value = '';

  constructor(containerEl: HTMLElement) {
    this.inputEl = createMockElement('textarea') as HTMLTextAreaElement;
  }

  setPlaceholder(placeholder: string): this {
    return this;
  }

  setValue(value: string): this {
    this.value = value;
    return this;
  }

  getValue(): string {
    return this.value;
  }

  onChange(callback: (value: string) => void): this {
    return this;
  }
}

// DropdownComponent mock
export class DropdownComponent {
  selectEl: HTMLSelectElement;
  private value = '';

  constructor(containerEl: HTMLElement) {
    this.selectEl = createMockElement('select') as HTMLSelectElement;
  }

  addOption(value: string, display: string): this {
    return this;
  }

  setValue(value: string): this {
    this.value = value;
    return this;
  }

  getValue(): string {
    return this.value;
  }

  onChange(callback: (value: string) => void): this {
    return this;
  }
}

// ToggleComponent mock
export class ToggleComponent {
  toggleEl: HTMLElement;
  private value = false;

  constructor(containerEl: HTMLElement) {
    this.toggleEl = createMockElement('div');
  }

  setValue(value: boolean): this {
    this.value = value;
    return this;
  }

  getValue(): boolean {
    return this.value;
  }

  onChange(callback: (value: boolean) => void): this {
    return this;
  }
}

// SliderComponent mock
export class SliderComponent {
  sliderEl: HTMLElement;
  private value = 0;

  constructor(containerEl: HTMLElement) {
    this.sliderEl = createMockElement('input');
  }

  setLimits(min: number, max: number, step: number): this {
    return this;
  }

  setValue(value: number): this {
    this.value = value;
    return this;
  }

  getValue(): number {
    return this.value;
  }

  setDynamicTooltip(): this {
    return this;
  }

  onChange(callback: (value: number) => void): this {
    return this;
  }
}

// ButtonComponent mock
export class ButtonComponent {
  buttonEl: HTMLButtonElement;
  private clickCallback?: () => void;

  constructor(containerEl: HTMLElement) {
    this.buttonEl = createMockElement('button') as HTMLButtonElement;
  }

  setButtonText(text: string): this {
    return this;
  }

  setIcon(icon: string): this {
    return this;
  }

  setTooltip(tooltip: string): this {
    return this;
  }

  setClass(cls: string): this {
    return this;
  }

  setCta(): this {
    return this;
  }

  setWarning(): this {
    return this;
  }

  setDisabled(disabled: boolean): this {
    return this;
  }

  onClick(callback: () => void): this {
    this.clickCallback = callback;
    return this;
  }

  // Helper for tests to trigger click
  click(): void {
    this.clickCallback?.();
  }
}

// Notice mock
export class Notice {
  constructor(message: string, timeout?: number) {
    // Mock - in tests we can spy on constructor calls
  }

  hide(): void {
    // Mock implementation
  }
}

// Component mock (base class for UI components like MessageBubble)
export class Component {
  private _domEvents: Array<{ el: any; type: string; handler: any }> = [];
  private _intervals: any[] = [];
  private _isLoaded = false;

  load(): void {
    this._isLoaded = true;
  }

  onload(): void {
    // Override in subclass
  }

  unload(): void {
    // Clean up registered DOM events
    for (const { el, type, handler } of this._domEvents) {
      if (el && typeof el.removeEventListener === 'function') {
        el.removeEventListener(type, handler);
      }
    }
    this._domEvents = [];

    // Clean up intervals
    for (const interval of this._intervals) {
      clearInterval(interval);
    }
    this._intervals = [];

    this._isLoaded = false;
  }

  onunload(): void {
    // Override in subclass
  }

  registerDomEvent(el: any, type: string, handler: any): void {
    this._domEvents.push({ el, type, handler });
    if (el && typeof el.addEventListener === 'function') {
      el.addEventListener(type, handler);
    }
  }

  registerInterval(interval: any): number {
    this._intervals.push(interval);
    return interval;
  }

  registerEvent(eventRef: EventRef): void {
    // Mock implementation
  }
}

// Plugin mock
export class Plugin extends Component {
  app: App;
  manifest: { id: string; name: string; version: string };

  constructor(app: App, manifest: { id: string; name: string; version: string }) {
    super();
    this.app = app;
    this.manifest = manifest;
  }

  addCommand(command: { id: string; name: string; callback?: () => void }): void {
    // Mock implementation
  }
}

// EventRef mock
export interface EventRef {
  // Empty interface for type compatibility
}

// Menu mock
export class Menu {
  addItem(callback: (item: MenuItem) => void): this {
    callback(new MenuItem());
    return this;
  }
}

// MenuItem mock
export class MenuItem {
  setTitle(title: string): this {
    return this;
  }

  setIcon(icon: string): this {
    return this;
  }

  onClick(callback: () => void): this {
    return this;
  }
}

// setIcon mock
export function setIcon(element: HTMLElement, iconId: string): void {
  // Mock implementation
}

// Helper to create mock DOM elements
function createMockElement(tagName: string): HTMLElement {
  // For Node.js environment, create a minimal mock
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
    createEl: jest.fn((_tag: string, _opts?: any) => createMockElement('div')),
    createDiv: jest.fn((_cls?: string | Record<string, any>) => createMockElement('div')),
    createSpan: jest.fn((_opts?: Record<string, any>) => createMockElement('span')),
    empty: jest.fn(),
    remove: jest.fn(),
    appendChild: jest.fn(),
    removeChild: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    setAttribute: jest.fn(),
    getAttribute: jest.fn(),
    querySelector: jest.fn(),
    querySelectorAll: jest.fn(() => []),
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

// requestUrl mock
export const requestUrl = jest.fn();

// normalizePath mock
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/');
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

// MarkdownFileInfo mock (used in editorCallback context)
export interface MarkdownFileInfo {
  file: TFile | null;
}
