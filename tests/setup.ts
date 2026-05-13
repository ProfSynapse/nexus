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
    createElement: jest.fn((tagName: string) => ({
      tagName: tagName.toUpperCase(),
      classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn(), contains: jest.fn(() => false) },
      setAttribute: jest.fn(),
      getAttribute: jest.fn(),
      removeAttribute: jest.fn(),
      appendChild: jest.fn(),
      removeChild: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      click: jest.fn(),
      focus: jest.fn(),
      style: {},
      textContent: '',
      value: ''
    })),
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
