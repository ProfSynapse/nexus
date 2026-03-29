/**
 * Shared mock factories for characterization and unit tests.
 *
 * Centralizes mock object creation to eliminate duplication across test files.
 * Each factory returns the superset of properties needed by all consumers.
 */

import { Plugin } from 'obsidian';

// ============================================================================
// Plugin / Service mocks (dual-backend, find-by-name)
// ============================================================================

/** Minimal mock Plugin instance suitable for service constructors. */
export function createMockPlugin(): Plugin {
  return new Plugin(
    { vault: {}, workspace: {} } as any,
    { id: 'test', name: 'Test', version: '0.0.1' }
  );
}

/** Mock FileSystemService with all JSONL read/write/list methods. */
export function createMockFileSystem(): any {
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
export function createMockIndexManager(): any {
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
export function createMockAdapter(ready: boolean): any {
  return {
    isReady: jest.fn().mockReturnValue(ready),
    // Workspace methods
    getWorkspaces: jest.fn().mockResolvedValue({ ...EMPTY_PAGE }),
    getWorkspace: jest.fn().mockResolvedValue(null),
    createWorkspace: jest.fn().mockResolvedValue('ws-new'),
    updateWorkspace: jest.fn(),
    deleteWorkspace: jest.fn(),
    searchWorkspaces: jest.fn().mockResolvedValue([]),
    // Session methods
    createSession: jest.fn().mockResolvedValue('session-new'),
    getSession: jest.fn().mockResolvedValue(null),
    getSessions: jest.fn().mockResolvedValue({ ...EMPTY_PAGE }),
    updateSession: jest.fn(),
    deleteSession: jest.fn(),
    // Trace methods
    addTrace: jest.fn().mockResolvedValue('trace-new'),
    getTraces: jest.fn().mockResolvedValue({ ...EMPTY_PAGE }),
    // State methods
    saveState: jest.fn().mockResolvedValue('state-new'),
    getState: jest.fn().mockResolvedValue(null),
    getStates: jest.fn().mockResolvedValue({ ...EMPTY_PAGE }),
    // Conversation methods
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

// ============================================================================
// DOM element mocks (model-dropdown, WorkspacesTab, oauth-banner)
// ============================================================================

/**
 * Mock HTMLElement with Obsidian-like API (createEl, createDiv, addClass, etc.).
 * Used for UI component tests that don't need child-tracking.
 */
export function createMockElement(): any {
  const element: any = {
    classList: {
      add: jest.fn(),
      remove: jest.fn(),
      contains: jest.fn(() => false),
    },
    addClass: jest.fn().mockReturnThis(),
    removeClass: jest.fn().mockReturnThis(),
    hasClass: jest.fn(() => false),
    setText: jest.fn().mockReturnThis(),
    createEl: jest.fn((_tag: string, _opts?: any) => createMockElement()),
    createDiv: jest.fn((clsOrOpts?: string | Record<string, any>) => {
      const child = createMockElement();
      if (typeof clsOrOpts === 'string') {
        child._cls = clsOrOpts;
      }
      return child;
    }),
    createSpan: jest.fn((_opts?: any) => createMockElement()),
    empty: jest.fn(),
    remove: jest.fn(),
    appendChild: jest.fn(),
    setAttribute: jest.fn(),
    getAttribute: jest.fn(),
    style: {},
    textContent: '',
    innerHTML: '',
    _cls: '',
  };
  return element;
}

/**
 * DOM-like mock element that tracks child creation for structural assertions.
 * Used by OAuth banner tests to verify DOM tree structure.
 */
export function createTrackingElement(): any {
  const children: any[] = [];
  const element: any = {
    _children: children,
    _tag: 'div',
    _cls: '',
    _text: '',
    textContent: '',
    onclick: null,
    disabled: false,
    classList: {
      add: jest.fn(),
      remove: jest.fn(),
      contains: jest.fn(() => false),
    },
    addClass: jest.fn(function(this: any, cls: string) { this._cls += ' ' + cls; return this; }),
    removeClass: jest.fn().mockReturnThis(),
    empty: jest.fn(function(this: any) { this._children.length = 0; }),
    setAttribute: jest.fn(),
    createEl: jest.fn((tag: string, opts?: any) => {
      const child = createTrackingElement();
      child._tag = tag;
      if (opts?.text) child.textContent = opts.text;
      if (opts?.cls) child._cls = opts.cls;
      children.push(child);
      return child;
    }),
    createDiv: jest.fn((cls?: string) => {
      const child = createTrackingElement();
      child._tag = 'div';
      if (cls) child._cls = cls;
      children.push(child);
      return child;
    }),
    createSpan: jest.fn((cls?: string) => {
      const child = createTrackingElement();
      child._tag = 'span';
      if (typeof cls === 'string') child._cls = cls;
      children.push(child);
      return child;
    }),
  };
  return element;
}
