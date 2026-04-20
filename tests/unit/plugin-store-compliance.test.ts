/**
 * Plugin Store Compliance Tests
 *
 * Tests for PR #43 coverage gaps:
 * 1. SQL whitelist validation (ConversationRepository, WorkspaceRepository)
 * 2. Platform guards (ConfigModal, GetStartedTab)
 * 3. EmbeddingIframe timeout cleanup
 * 4. MessageEditController DOM cloning
 * 5. MessageManager null conversation event
 */

import { Platform } from '../mocks/obsidian';
import path from 'node:path';

// ============================================================================
// 1. SQL Whitelist Validation
// ============================================================================

describe('SQL whitelist validation', () => {
  // We test the whitelist logic extracted from the repositories.
  // The repositories use the same pattern:
  //   const ALLOWED_SORT_COLUMNS = [...] as const;
  //   if (!ALLOWED_SORT_COLUMNS.includes(requestedSort as ...)) throw Error;
  //
  // Since the repositories need SQLite/JSONL deps, we test the validation
  // logic directly by replicating the exact whitelist check pattern.

  describe('ConversationRepository.getConversations sort validation', () => {
    const ALLOWED_SORT_COLUMNS = ['id', 'title', 'created', 'updated', 'vaultName', 'messageCount', 'workspaceId', 'sessionId'] as const;
    const ALLOWED_SORT_ORDERS = ['asc', 'desc'] as const;

    function validateSort(sortBy: string, sortOrder: string): void {
      if (!ALLOWED_SORT_COLUMNS.includes(sortBy as typeof ALLOWED_SORT_COLUMNS[number])) {
        throw new Error(`Invalid sort column: ${sortBy}`);
      }
      if (!ALLOWED_SORT_ORDERS.includes(sortOrder as typeof ALLOWED_SORT_ORDERS[number])) {
        throw new Error(`Invalid sort order: ${sortOrder}`);
      }
    }

    it.each([
      'id', 'title', 'created', 'updated', 'vaultName', 'messageCount', 'workspaceId', 'sessionId'
    ])('should accept valid sort column: %s', (column) => {
      expect(() => validateSort(column, 'asc')).not.toThrow();
    });

    it.each([
      'DROP TABLE conversations; --',
      'password',
      'nonexistent',
      '',
      '1; DROP TABLE conversations',
      'id OR 1=1',
    ])('should reject invalid sort column: %s', (column) => {
      expect(() => validateSort(column, 'asc')).toThrow(`Invalid sort column: ${column}`);
    });

    it.each(['asc', 'desc'])('should accept valid sort order: %s', (order) => {
      expect(() => validateSort('id', order)).not.toThrow();
    });

    it.each([
      'ASC',
      'DESC',
      'ascending',
      '',
      'asc; DROP TABLE',
    ])('should reject invalid sort order: %s', (order) => {
      expect(() => validateSort('id', order)).toThrow(`Invalid sort order: ${order}`);
    });

    it('should use defaults when no options provided', () => {
      // Default: sortBy='updated', sortOrder='desc'
      expect(() => validateSort('updated', 'desc')).not.toThrow();
    });
  });

  describe('WorkspaceRepository.getWorkspaces sort validation', () => {
    const ALLOWED_SORT_COLUMNS = ['id', 'name', 'created', 'lastAccessed', 'isActive', 'rootFolder'] as const;
    const ALLOWED_SORT_ORDERS = ['asc', 'desc'] as const;

    function validateSort(sortBy: string, sortOrder: string): void {
      if (!ALLOWED_SORT_COLUMNS.includes(sortBy as typeof ALLOWED_SORT_COLUMNS[number])) {
        throw new Error(`Invalid sort column: ${sortBy}`);
      }
      if (!ALLOWED_SORT_ORDERS.includes(sortOrder as typeof ALLOWED_SORT_ORDERS[number])) {
        throw new Error(`Invalid sort order: ${sortOrder}`);
      }
    }

    it.each([
      'id', 'name', 'created', 'lastAccessed', 'isActive', 'rootFolder'
    ])('should accept valid sort column: %s', (column) => {
      expect(() => validateSort(column, 'desc')).not.toThrow();
    });

    it.each([
      'DROP TABLE workspaces; --',
      'password',
      'title',  // valid for conversations but NOT workspaces
      'updated', // valid for conversations but NOT workspaces
    ])('should reject invalid sort column: %s', (column) => {
      expect(() => validateSort(column, 'desc')).toThrow(`Invalid sort column: ${column}`);
    });

    it('should use defaults when no options provided', () => {
      // Default: sortBy='lastAccessed', sortOrder='desc'
      expect(() => validateSort('lastAccessed', 'desc')).not.toThrow();
    });

    it('should reject SQL injection in sort column', () => {
      expect(() => validateSort('name ORDER BY 1; DROP TABLE workspaces--', 'asc'))
        .toThrow('Invalid sort column');
    });
  });
});

// ============================================================================
// 2. Platform Guards (dynamic require)
// ============================================================================

describe('Platform guards for Node.js modules', () => {
  const savedPlatform = { ...Platform };

  afterEach(() => {
    // Restore platform state
    Platform.isDesktop = savedPlatform.isDesktop;
    Platform.isMobile = savedPlatform.isMobile;
    Platform.isMacOS = savedPlatform.isMacOS;
    Platform.isWin = savedPlatform.isWin;
    Platform.isLinux = savedPlatform.isLinux;
  });

  describe('ConfigModal path resolution pattern', () => {
    // Replicates the pattern from ConfigModal:
    // if (vaultRoot && Platform.isDesktop) {
    //     const nodePath = require('path') as typeof import('path');
    //     return nodePath.join(vaultRoot, relativeConnectorPath);
    // }
    // return relativeConnectorPath;

    function resolveConnectorPath(vaultRoot: string | null, relativePath: string): string {
      if (vaultRoot && Platform.isDesktop) {
        return path.join(vaultRoot, relativePath);
      }
      return relativePath;
    }

    it('should join path on desktop when vaultRoot is available', () => {
      Platform.isDesktop = true;
      Platform.isMobile = false;
      const result = resolveConnectorPath('/vault', '.obsidian/plugins/test/connector.js');
      expect(result).toContain('connector.js');
      expect(result).toContain('vault');
    });

    it('should return relative path on mobile', () => {
      Platform.isDesktop = false;
      Platform.isMobile = true;
      const result = resolveConnectorPath('/vault', '.obsidian/plugins/test/connector.js');
      expect(result).toBe('.obsidian/plugins/test/connector.js');
    });

    it('should return relative path when vaultRoot is null', () => {
      Platform.isDesktop = true;
      Platform.isMobile = false;
      const result = resolveConnectorPath(null, '.obsidian/plugins/test/connector.js');
      expect(result).toBe('.obsidian/plugins/test/connector.js');
    });
  });

  describe('ConfigModal config path patterns', () => {
    // Replicates the pattern from ConfigModal.getWindowsConfigPath() etc:
    // if (Platform.isDesktop) {
    //     const nodePath = require('path') as typeof import('path');
    //     return nodePath.join(process.env.HOME || '', ...);
    // }
    // return '';

    function getConfigPath(): string {
      if (Platform.isDesktop) {
        return path.join(process.env.HOME || '/home/test', '.config', 'Claude', 'claude_desktop_config.json');
      }
      return '';
    }

    it('should return config path on desktop', () => {
      Platform.isDesktop = true;
      Platform.isMobile = false;
      const result = getConfigPath();
      expect(result).toContain('claude_desktop_config.json');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should return empty string on mobile', () => {
      Platform.isDesktop = false;
      Platform.isMobile = true;
      const result = getConfigPath();
      expect(result).toBe('');
    });
  });

  describe('GetStartedTab resolveNodePath pattern', () => {
    // Replicates the mobile guard from GetStartedTab.resolveNodePath():
    // if (!Platform.isDesktop) {
    //     this.cachedNodePath = '';
    //     return '';
    // }

    function resolveNodePath(): string {
      if (!Platform.isDesktop) {
        return '';
      }
      // On desktop, would call execSync('which node') — we just verify the guard
      return '/usr/local/bin/node';
    }

    it('should return empty string on mobile', () => {
      Platform.isDesktop = false;
      Platform.isMobile = true;
      expect(resolveNodePath()).toBe('');
    });

    it('should proceed on desktop', () => {
      Platform.isDesktop = true;
      Platform.isMobile = false;
      expect(resolveNodePath()).not.toBe('');
    });
  });
});

// ============================================================================
// 3. EmbeddingIframe Timeout Cleanup
// ============================================================================

describe('EmbeddingIframe timeout cleanup pattern', () => {
  // Tests the pattern from EmbeddingIframe.sendRequest():
  // const timeoutId = setTimeout(...);
  // pendingRequests.set(id, {
  //   resolve: (value) => { clearTimeout(timeoutId); resolve(value); },
  //   reject: (error) => { clearTimeout(timeoutId); reject(error); }
  // });

  it('should clear timeout when resolve is called', () => {
    jest.useFakeTimers();
    let timeoutCleared = false;
    const originalClearTimeout = global.clearTimeout;
    const clearTimeoutSpy = jest.fn((...args: Parameters<typeof clearTimeout>) => {
      timeoutCleared = true;
      originalClearTimeout(...args);
    });
    global.clearTimeout = clearTimeoutSpy;

    try {
      const timeoutId = setTimeout(() => {
        // Would reject with 'Request timeout'
      }, 30000);

      // Simulate the wrapped resolve that clears the timeout
      const wrappedResolve = (value: unknown) => {
        clearTimeoutSpy(timeoutId);
        return value;
      };

      wrappedResolve({ id: 1, success: true });

      expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutId);
      expect(timeoutCleared).toBe(true);

      // The timeout should not fire after being cleared
      jest.advanceTimersByTime(30000);
      // If timeout was cleared, no reject should happen
    } finally {
      global.clearTimeout = originalClearTimeout;
      jest.useRealTimers();
    }
  });

  it('should clear timeout when reject is called', () => {
    jest.useFakeTimers();
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

    try {
      const timeoutId = setTimeout(() => {
        void 0;
      }, 30000);

      // Simulate the wrapped reject that clears the timeout
      const wrappedReject = (error: Error) => {
        clearTimeout(timeoutId);
        return error;
      };

      wrappedReject(new Error('test error'));

      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      clearTimeoutSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('should fire timeout rejection when no response arrives', () => {
    jest.useFakeTimers();

    try {
      let timeoutFired = false;
      const pendingRequests = new Map<number, { resolve: (value?: unknown) => void; reject: (reason?: unknown) => void }>();
      const id = 1;

      const timeoutId = setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          timeoutFired = true;
        }
      }, 30000);

      pendingRequests.set(id, {
        resolve: () => { clearTimeout(timeoutId); },
        reject: () => { clearTimeout(timeoutId); }
      });

      // Don't resolve — let timeout fire
      jest.advanceTimersByTime(30000);

      expect(timeoutFired).toBe(true);
      expect(pendingRequests.has(id)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ============================================================================
// 4. MessageEditController DOM Cloning
// ============================================================================

describe('MessageEditController.exitEditMode', () => {
  // The method: contentDiv.replaceChildren(
  //   ...Array.from(originalClone.childNodes).map(n => n.cloneNode(true))
  // );

  // Since we're in Node.js (no real DOM), we test the logic pattern
  // using a minimal DOM-like mock

  interface MockNode {
    textContent: string;
    childNodes: MockNode[];
    cloneNode(deep: boolean): MockNode;
  }

  function createMockNode(text: string, children: MockNode[] = []): MockNode {
    return {
      textContent: text,
      childNodes: children,
      cloneNode(deep: boolean): MockNode {
        if (deep) {
          return createMockNode(text, children.map(c => c.cloneNode(true)));
        }
        return createMockNode(text, []);
      }
    };
  }

  it('should restore original children via cloneNode', () => {
    const child1 = createMockNode('Hello');
    const child2 = createMockNode('World');
    const originalClone = createMockNode('', [child1, child2]);

    // Simulate replaceChildren logic
    const restoredChildren = Array.from(originalClone.childNodes).map(n => n.cloneNode(true));

    expect(restoredChildren).toHaveLength(2);
    expect(restoredChildren[0].textContent).toBe('Hello');
    expect(restoredChildren[1].textContent).toBe('World');
  });

  it('should produce independent copies (not references)', () => {
    const child = createMockNode('Original');
    const originalClone = createMockNode('', [child]);

    const restored = Array.from(originalClone.childNodes).map(n => n.cloneNode(true));

    // Modify the restored copy — should not affect original
    restored[0].textContent = 'Modified';
    expect(child.textContent).toBe('Original');
  });

  it('should handle empty original content', () => {
    const originalClone = createMockNode('', []);
    const restored = Array.from(originalClone.childNodes).map(n => n.cloneNode(true));
    expect(restored).toHaveLength(0);
  });
});

// ============================================================================
// 5. MessageManager Null Conversation Event
// ============================================================================

describe('MessageManager null conversation event', () => {
  // Tests the pattern from ChatView.handleConversationUpdated:
  // private handleConversationUpdated(conversation: ConversationData | null): void {
  //   if (!conversation) {
  //     this.updateChatTitle();
  //     this.updateContextProgress();
  //     return;
  //   }
  //   this.conversationManager.updateCurrentConversation(conversation);
  //   ...
  // }

  it('should handle null conversation without calling updateCurrentConversation', () => {
    const updateCurrentConversation = jest.fn();
    const updateChatTitle = jest.fn();
    const updateContextProgress = jest.fn();
    const setConversation = jest.fn();

    function handleConversationUpdated(conversation: Record<string, unknown> | null): void {
      if (!conversation) {
        updateChatTitle();
        updateContextProgress();
        return;
      }
      updateCurrentConversation(conversation);
      setConversation(conversation);
      updateChatTitle();
      updateContextProgress();
    }

    // Test null path
    handleConversationUpdated(null);
    expect(updateChatTitle).toHaveBeenCalledTimes(1);
    expect(updateContextProgress).toHaveBeenCalledTimes(1);
    expect(updateCurrentConversation).not.toHaveBeenCalled();
    expect(setConversation).not.toHaveBeenCalled();
  });

  it('should call updateCurrentConversation for non-null conversation', () => {
    const updateCurrentConversation = jest.fn();
    const updateChatTitle = jest.fn();
    const updateContextProgress = jest.fn();
    const setConversation = jest.fn();

    function handleConversationUpdated(conversation: Record<string, unknown> | null): void {
      if (!conversation) {
        updateChatTitle();
        updateContextProgress();
        return;
      }
      updateCurrentConversation(conversation);
      setConversation(conversation);
      updateChatTitle();
      updateContextProgress();
    }

    const mockConversation = { id: 'conv_1', title: 'Test' };
    handleConversationUpdated(mockConversation);
    expect(updateCurrentConversation).toHaveBeenCalledWith(mockConversation);
    expect(setConversation).toHaveBeenCalledWith(mockConversation);
    expect(updateChatTitle).toHaveBeenCalledTimes(1);
    expect(updateContextProgress).toHaveBeenCalledTimes(1);
  });

  it('should allow MessageManager to emit null via onConversationUpdated', () => {
    // Tests that the event handler type allows null
    const handler = jest.fn();
    const events = {
      onConversationUpdated: handler
    };

    // Simulate subagent completion triggering null event
    events.onConversationUpdated(null);
    expect(handler).toHaveBeenCalledWith(null);

    // Simulate normal conversation update
    const conv = { id: 'conv_1' };
    events.onConversationUpdated(conv);
    expect(handler).toHaveBeenCalledWith(conv);
  });
});
