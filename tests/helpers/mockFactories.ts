/**
 * Shared mock factories for characterization and unit tests.
 *
 * Centralizes mock object creation to eliminate duplication across test files.
 * Each factory returns the superset of properties needed by all consumers.
 */

import { App, Plugin } from 'obsidian';

type MockFn<Args extends unknown[] = unknown[], Return = unknown> = jest.Mock<Return, Args>;

interface MockFileSystem {
  readWorkspace: MockFn;
  writeWorkspace: MockFn;
  deleteWorkspace: MockFn;
  listWorkspaceIds: MockFn<[], Promise<string[]>>;
  readConversation: MockFn;
  writeConversation: MockFn;
  deleteConversation: MockFn;
  listConversationIds: MockFn<[], Promise<string[]>>;
}

interface MockIndexManager {
  loadWorkspaceIndex: MockFn<[], Promise<{
    workspaces: Record<string, unknown>;
    byName: Record<string, unknown>;
    byDescription: Record<string, unknown>;
    byFolder: Record<string, unknown>;
  }>>;
  loadConversationIndex: MockFn<[], Promise<{ conversations: Record<string, unknown> }>>;
  updateWorkspaceInIndex: MockFn;
  removeWorkspaceFromIndex: MockFn;
  updateConversationInIndex: MockFn;
  removeConversationFromIndex: MockFn;
}

interface MockStorageAdapter {
  isReady: MockFn<[], boolean>;
  getWorkspaces: MockFn<[], Promise<Record<string, unknown>>>;
  getWorkspace: MockFn<[], Promise<unknown>>;
  createWorkspace: MockFn<[], Promise<string>>;
  updateWorkspace: MockFn;
  deleteWorkspace: MockFn;
  searchWorkspaces: MockFn<[], Promise<unknown[]>>;
  createSession: MockFn<[], Promise<string>>;
  getSession: MockFn<[], Promise<unknown>>;
  getSessions: MockFn<[], Promise<Record<string, unknown>>>;
  updateSession: MockFn;
  deleteSession: MockFn;
  addTrace: MockFn<[], Promise<string>>;
  getTraces: MockFn<[], Promise<Record<string, unknown>>>;
  saveState: MockFn<[], Promise<string>>;
  getState: MockFn<[], Promise<unknown>>;
  getStates: MockFn<[], Promise<Record<string, unknown>>>;
  getConversations: MockFn<[], Promise<Record<string, unknown>>>;
  getConversation: MockFn<[], Promise<unknown>>;
  getMessages: MockFn<[], Promise<Record<string, unknown>>>;
  createConversation: MockFn<[], Promise<string>>;
  updateConversation: MockFn;
  updateMessage: MockFn;
  deleteMessage: MockFn;
  deleteConversation: MockFn;
}

interface MockElementOptions {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
}

interface MockElement {
  classList: {
    add: MockFn<[string]>;
    remove: MockFn<[string]>;
    contains: MockFn<[string], boolean>;
  };
  addClass: MockFn<[string], MockElement>;
  removeClass: MockFn<[string], MockElement>;
  hasClass: MockFn<[string], boolean>;
  setText: MockFn<[string], MockElement>;
  createEl: MockFn<[string, MockElementOptions?], MockElement>;
  createDiv: MockFn<[string | MockElementOptions?], MockElement>;
  createSpan: MockFn<[MockElementOptions?], MockElement>;
  empty: MockFn<[], void>;
  remove: MockFn<[], void>;
  appendChild: MockFn<[MockElement], MockElement>;
  setAttribute: MockFn<[string, string], void>;
  getAttribute: MockFn<[string], string | null>;
  querySelector?: MockFn<[string], MockElement | null>;
  querySelectorAll?: MockFn<[string], MockElement[]>;
  style: Record<string, unknown>;
  textContent: string;
  innerHTML: string;
  _cls: string;
  _children?: MockElement[];
  _tag?: string;
  _text?: string;
  onclick?: (() => void) | null;
  disabled?: boolean;
  className?: string;
  children?: MockElement[];
  value?: string;
  scrollTop?: number;
  scrollHeight?: number;
  focus?: MockFn<[], void>;
  firstElementChild?: MockElement | null;
  nextElementSibling?: MockElement | null;
}

/** Minimal mock Plugin instance suitable for service constructors. */
export function createMockPlugin(): Plugin {
  return new Plugin(
    { vault: {}, workspace: {} } as unknown as App,
    { id: 'test', name: 'Test', version: '0.0.1' }
  );
}

/** Mock FileSystemService with all JSONL read/write/list methods. */
export function createMockFileSystem(): MockFileSystem {
  return {
    readWorkspace: jest.fn(),
    writeWorkspace: jest.fn(),
    deleteWorkspace: jest.fn(),
    listWorkspaceIds: jest.fn().mockResolvedValue([]),
    readConversation: jest.fn(),
    writeConversation: jest.fn(),
    deleteConversation: jest.fn(),
    listConversationIds: jest.fn().mockResolvedValue([]),
  };
}

/** Mock IndexManager with workspace and conversation index methods. */
export function createMockIndexManager(): MockIndexManager {
  return {
    loadWorkspaceIndex: jest.fn().mockResolvedValue({
      workspaces: {},
      byName: {},
      byDescription: {},
      byFolder: {},
    }),
    loadConversationIndex: jest.fn().mockResolvedValue({
      conversations: {},
    }),
    updateWorkspaceInIndex: jest.fn(),
    removeWorkspaceFromIndex: jest.fn(),
    updateConversationInIndex: jest.fn(),
    removeConversationFromIndex: jest.fn(),
  };
}

const EMPTY_PAGE = { items: [], page: 0, pageSize: 100, totalItems: 0, totalPages: 0, hasNextPage: false };
const EMPTY_MSG_PAGE = { items: [], page: 0, pageSize: 1000, totalItems: 0, totalPages: 0, hasNextPage: false };

/**
 * Mock IStorageAdapter. When `ready` is true, isReady() returns true and
 * adapter methods will be used. When false, legacy path is used.
 */
export function createMockAdapter(ready: boolean): MockStorageAdapter {
  return {
    isReady: jest.fn().mockReturnValue(ready),
    getWorkspaces: jest.fn().mockResolvedValue({ ...EMPTY_PAGE }),
    getWorkspace: jest.fn().mockResolvedValue(null),
    createWorkspace: jest.fn().mockResolvedValue('ws-new'),
    updateWorkspace: jest.fn(),
    deleteWorkspace: jest.fn(),
    searchWorkspaces: jest.fn().mockResolvedValue([]),
    createSession: jest.fn().mockResolvedValue('session-new'),
    getSession: jest.fn().mockResolvedValue(null),
    getSessions: jest.fn().mockResolvedValue({ ...EMPTY_PAGE }),
    updateSession: jest.fn(),
    deleteSession: jest.fn(),
    addTrace: jest.fn().mockResolvedValue('trace-new'),
    getTraces: jest.fn().mockResolvedValue({ ...EMPTY_PAGE }),
    saveState: jest.fn().mockResolvedValue('state-new'),
    getState: jest.fn().mockResolvedValue(null),
    getStates: jest.fn().mockResolvedValue({ ...EMPTY_PAGE }),
    getConversations: jest.fn().mockResolvedValue({ ...EMPTY_PAGE }),
    getConversation: jest.fn().mockResolvedValue(null),
    getMessages: jest.fn().mockResolvedValue({ ...EMPTY_MSG_PAGE }),
    createConversation: jest.fn().mockResolvedValue('conv-new'),
    updateConversation: jest.fn(),
    updateMessage: jest.fn(),
    deleteMessage: jest.fn(),
    deleteConversation: jest.fn(),
  };
}

function createBaseElement(tag: string): MockElement {
  const element: MockElement = {
    classList: {
      add: jest.fn(),
      remove: jest.fn(),
      contains: jest.fn(() => false),
    },
    addClass: jest.fn().mockImplementation(function (this: MockElement, cls: string) {
      this._cls = `${this._cls} ${cls}`.trim();
      return this;
    }),
    removeClass: jest.fn().mockReturnThis(),
    hasClass: jest.fn(() => false),
    setText: jest.fn().mockImplementation(function (this: MockElement, text: string) {
      this.textContent = text;
      return this;
    }),
    createEl: jest.fn((childTag: string, opts?: MockElementOptions) => createMockElement(childTag, opts)),
    createDiv: jest.fn((clsOrOpts?: string | MockElementOptions) => createMockElement('div', typeof clsOrOpts === 'string' ? { cls: clsOrOpts } : clsOrOpts)),
    createSpan: jest.fn((opts?: MockElementOptions) => createMockElement('span', opts)),
    empty: jest.fn(),
    remove: jest.fn(),
    appendChild: jest.fn().mockImplementation(function (this: MockElement, child: MockElement) {
      (this._children ??= []).push(child);
      return child;
    }),
    setAttribute: jest.fn(),
    getAttribute: jest.fn(() => null),
    style: {},
    textContent: '',
    innerHTML: '',
    _cls: '',
    _tag: tag,
    _children: [],
    value: '',
    scrollTop: 0,
    scrollHeight: 0,
    focus: jest.fn(),
    firstElementChild: null,
    nextElementSibling: null,
  };
  return element;
}

/**
 * Mock HTMLElement with Obsidian-like API (createEl, createDiv, addClass, etc.).
 * Used for UI component tests that don't need child-tracking.
 */
export function createMockElement(tag = 'div', opts?: MockElementOptions): MockElement {
  const element = createBaseElement(tag);
  if (opts?.cls) {
    element._cls = opts.cls;
  }
  if (opts?.text) {
    element.textContent = opts.text;
  }
  return element;
}

/**
 * DOM-like mock element that tracks child creation for structural assertions.
 * Used by OAuth banner tests to verify DOM tree structure.
 */
export function createTrackingElement(): MockElement {
  const children: MockElement[] = [];
  const element = createBaseElement('div');
  element._children = children;
  element.addClass = jest.fn(function (this: MockElement, cls: string) {
    this._cls = `${this._cls} ${cls}`.trim();
    return this;
  });
  element.empty = jest.fn(function (this: MockElement) {
    children.length = 0;
    this._children = children;
  });
  element.createEl = jest.fn((tag: string, opts?: MockElementOptions) => {
    const child = createTrackingElement();
    child._tag = tag;
    if (opts?.text) {
      child.textContent = opts.text;
    }
    if (opts?.cls) {
      child._cls = opts.cls;
    }
    children.push(child);
    return child;
  });
  element.createDiv = jest.fn((cls?: string) => {
    const child = createTrackingElement();
    child._tag = 'div';
    if (cls) {
      child._cls = cls;
    }
    children.push(child);
    return child;
  });
  element.createSpan = jest.fn((cls?: string) => {
    const child = createTrackingElement();
    child._tag = 'span';
    if (typeof cls === 'string') {
      child._cls = cls;
    }
    children.push(child);
    return child;
  });
  return element;
}
