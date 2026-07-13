/**
 * Jest Setup File
 *
 * Runs before each test file to configure the testing environment.
 */

declare global {
  var require: NodeJS.Require | undefined;
}

const testGlobal = globalThis as unknown as {
  window?: Window & typeof globalThis;
  document?: Document;
  navigator?: Navigator;
  indexedDB?: IDBFactory;
};

// Obsidian augments the global scope with createEl/createDiv/createSpan/createFragment
// (detached element creation). The node test environment has no DOM, so provide
// lightweight mock elements supporting the Obsidian element API surface the code uses.
type MockEl = Record<string, unknown>;
type CreationInfo = DomElementInfo | string;

const applyCreationInfo = (element: unknown, info?: CreationInfo): unknown => {
  if (!info || typeof element !== 'object' || element === null) return element;

  const el = element as Record<string, unknown>;
  const normalized: DomElementInfo = typeof info === 'string' ? { cls: info } : info;
  const classes = typeof normalized.cls === 'string'
    ? normalized.cls.split(/\s+/).filter(Boolean)
    : normalized.cls ?? [];
  if (classes.length > 0) {
    el.className = classes.join(' ');
    const classList = el.classList as { add?: (...tokens: string[]) => void } | undefined;
    classList?.add?.(...classes);
  }

  if (typeof normalized.text === 'string') {
    el.textContent = normalized.text;
  } else if (normalized.text) {
    (el.appendChild as ((child: Node) => unknown) | undefined)?.(normalized.text);
  }

  const setAttribute = el.setAttribute as ((name: string, value: string) => void) | undefined;
  const removeAttribute = el.removeAttribute as ((name: string) => void) | undefined;
  for (const [name, value] of Object.entries(normalized.attr ?? {})) {
    if (value === null) removeAttribute?.(name);
    else setAttribute?.(name, String(value));
  }

  for (const property of ['title', 'value', 'type', 'placeholder', 'href'] as const) {
    const value = normalized[property];
    if (value !== undefined) el[property] = value;
  }

  if (normalized.parent) {
    if (normalized.prepend && 'prepend' in normalized.parent) {
      normalized.parent.prepend(element as Node);
    } else {
      normalized.parent.appendChild(element as Node);
    }
  }

  return element;
};

const createMockEl = (tag = 'div', info?: CreationInfo): MockEl => {
  const el: MockEl = {
    tagName: tag.toUpperCase(),
    className: '',
    style: {},
    textContent: '',
    innerHTML: '',
    classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn(), contains: jest.fn(() => false) },
    addClass: jest.fn(() => el),
    removeClass: jest.fn(() => el),
    toggleClass: jest.fn(() => el),
    hasClass: jest.fn(() => false),
    setAttribute: jest.fn(),
    getAttribute: jest.fn(),
    removeAttribute: jest.fn(),
    setAttr: jest.fn(),
    setText: jest.fn(),
    empty: jest.fn(),
    detach: jest.fn(),
    remove: jest.fn(),
    appendChild: jest.fn((c: unknown) => c),
    append: jest.fn(),
    prepend: jest.fn(),
    removeChild: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    querySelector: jest.fn(() => null),
    querySelectorAll: jest.fn(() => []),
    click: jest.fn(),
    focus: jest.fn(),
    createEl: jest.fn((t: string, options?: DomElementInfo) => createMockEl(t, options)),
    createDiv: jest.fn((options?: CreationInfo) => createMockEl('div', options)),
    createSpan: jest.fn((options?: CreationInfo) => createMockEl('span', options)),
  };
  return applyCreationInfo(el, info) as MockEl;
};
// Delegate the global creators to window.activeDocument at call time. Tests that
// track/override `document.createElement` (e.g. element-structure assertions) then
// capture globally-created elements transparently; otherwise fall back to a mock.
const activeDoc = () => (globalThis as unknown as { window?: { activeDocument?: {
  createElement?: (tag: string) => unknown;
  createDocumentFragment?: () => unknown;
} } }).window?.activeDocument;
const createDetachedElement = (tag: string, info?: CreationInfo) => {
  const element = activeDoc()?.createElement?.(tag) ?? createMockEl(tag);
  return applyCreationInfo(element, info);
};
const globalWithCreators = globalThis as unknown as Record<string, unknown>;
globalWithCreators.createEl = (tag: string, info?: DomElementInfo) => createDetachedElement(tag, info);
globalWithCreators.createDiv = (info?: CreationInfo) => createDetachedElement('div', info);
globalWithCreators.createSpan = (info?: CreationInfo) => createDetachedElement('span', info);
globalWithCreators.createFragment = () => {
  const frag = activeDoc()?.createDocumentFragment?.();
  if (frag) return frag;
  const mock = createMockEl('fragment');
  mock.appendChild = jest.fn((c: unknown) => c);
  return mock;
};

if (!testGlobal.window) {
  const idbFactory = (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB
    ?? (require('fake-indexeddb') as { indexedDB: IDBFactory }).indexedDB;
  const testNavigator = {
    storage: {
      persist: jest.fn().mockResolvedValue(true)
    }
  } as unknown as Navigator;

  const mockDocument = {
    body: {
      appendChild: jest.fn(),
      removeChild: jest.fn(),
      createDiv: jest.fn(() => ({ remove: jest.fn() })),
      focus: jest.fn()
    },
    createElement: jest.fn((tagName: string) => ({ ...createMockEl(tagName), value: '' })),
    createTextNode: jest.fn((text: string) => ({ textContent: text })),
    createDocumentFragment: jest.fn(() => ({ appendChild: jest.fn() })),
    createRange: jest.fn(() => ({
      setStart: jest.fn(),
      setEnd: jest.fn(),
      selectNodeContents: jest.fn(),
      collapse: jest.fn()
    })),
    createTreeWalker: jest.fn(() => ({ nextNode: jest.fn(() => null) })),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    activeElement: null
  } as unknown as Document;

  const mockWindow = {
    setTimeout: ((...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args)) as typeof setTimeout,
    clearTimeout: ((...args: Parameters<typeof clearTimeout>) => globalThis.clearTimeout(...args)) as typeof clearTimeout,
    setInterval: ((...args: Parameters<typeof setInterval>) => globalThis.setInterval(...args)) as typeof setInterval,
    clearInterval: ((...args: Parameters<typeof clearInterval>) => globalThis.clearInterval(...args)) as typeof clearInterval,
    requestAnimationFrame: (callback: FrameRequestCallback) => globalThis.setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: globalThis.clearTimeout,
    getComputedStyle: jest.fn(() => ({ paddingLeft: '0', paddingRight: '0' })),
    localStorage: {
      getItem: jest.fn(() => null),
      setItem: jest.fn(),
      removeItem: jest.fn(),
      clear: jest.fn()
    },
    require,
    crypto: globalThis.crypto,
  } as unknown as Window & typeof globalThis;

  Object.defineProperty(mockWindow, 'activeDocument', {
    configurable: true,
    get: () => testGlobal.document ?? mockDocument
  });
  Object.defineProperty(mockWindow, 'activeWindow', {
    configurable: true,
    get: () => mockWindow
  });
  Object.defineProperty(mockWindow, 'navigator', {
    configurable: true,
    get: () => testGlobal.navigator
  });
  Object.defineProperty(mockWindow, 'indexedDB', {
    configurable: true,
    get: () => testGlobal.indexedDB
  });

  testGlobal.window = mockWindow;
  testGlobal.document = mockDocument;
  testGlobal.navigator = testNavigator;
  testGlobal.indexedDB = idbFactory;
}

// Extend Jest timeout for async operations
jest.setTimeout(10000);

const originalGlobalRequire = globalThis.require;

beforeAll(() => {
  globalThis.require = require;
});

afterAll(() => {
  globalThis.require = originalGlobalRequire;
});

// Mock console.error to reduce noise in tests (but still capture for assertions)
const originalConsoleError = console.error;
beforeAll(() => {
  console.error = jest.fn((...args) => {
    // Still log to help debug failing tests
    if (process.env.DEBUG_TESTS) {
      originalConsoleError(...args);
    }
  });
});

afterAll(() => {
  console.error = originalConsoleError;
});

// Clear all mocks between tests
beforeEach(() => {
  jest.clearAllMocks();
});
