/**
 * Characterization Tests: Dual-Backend Pattern
 *
 * Documents the current behavior of the dual-backend (adapter vs legacy) pattern
 * used across WorkspaceService, ConversationService, and MemoryService.
 *
 * Pattern: Each public method calls getReadyAdapter(). If adapter is available
 * and isReady() returns true, uses adapter path. Otherwise falls back to
 * legacy FileSystemService + IndexManager path.
 *
 * These tests lock down behavior BEFORE extraction into DualBackendExecutor.
 */

import { WorkspaceService } from '../../src/services/WorkspaceService';
import { ConversationService } from '../../src/services/ConversationService';
import { MemoryService } from '../../src/agents/memoryManager/services/MemoryService';
import { WorkspaceStateService } from '../../src/services/workspace/WorkspaceStateService';
import { createMockPlugin, createMockFileSystem, createMockIndexManager, createMockAdapter } from '../helpers/mockFactories';

// ============================================================================
// WorkspaceService: Dual-Backend Characterization
// ============================================================================

describe('WorkspaceService dual-backend characterization', () => {
  const plugin = createMockPlugin();

  describe('when adapter IS ready (adapter path)', () => {
    it('listWorkspaces delegates to adapter.getWorkspaces', async () => {
      const fs = createMockFileSystem();
      const idx = createMockIndexManager();
      const adapter = createMockAdapter(true);

      adapter.getWorkspaces.mockResolvedValue({
        items: [
          { id: 'ws1', name: 'Workspace 1', description: 'desc', rootFolder: '/', created: 1000, lastAccessed: 2000, isActive: true },
        ],
        page: 0, pageSize: 100, totalItems: 1, totalPages: 1, hasNextPage: false,
      });

      const service = new WorkspaceService(plugin, fs, idx, adapter);
      const result = await service.listWorkspaces();

      expect(adapter.getWorkspaces).toHaveBeenCalled();
      expect(idx.loadWorkspaceIndex).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('ws1');
      // Characterization: convertWorkspaceMetadata sets sessionCount and traceCount to 0
      expect(result[0].sessionCount).toBe(0);
      expect(result[0].traceCount).toBe(0);
    });

    it('createWorkspace delegates to adapter.createWorkspace', async () => {
      const fs = createMockFileSystem();
      const idx = createMockIndexManager();
      const adapter = createMockAdapter(true);
      adapter.createWorkspace.mockResolvedValue('ws-created');

      const service = new WorkspaceService(plugin, fs, idx, adapter);
      const result = await service.createWorkspace({ name: 'New WS', rootFolder: '/test' });

      expect(adapter.createWorkspace).toHaveBeenCalled();
      expect(fs.writeWorkspace).not.toHaveBeenCalled();
      expect(result.id).toBe('ws-created');
      expect(result.name).toBe('New WS');
      expect(result.sessions).toEqual({});
    });

    it('createWorkspace reuses the existing default workspace after a unique-name race', async () => {
      const fs = createMockFileSystem();
      const idx = createMockIndexManager();
      const adapter = createMockAdapter(true);

      adapter.createWorkspace.mockRejectedValue(
        new Error('SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: workspaces.name')
      );
      adapter.getWorkspace
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'ws-existing-default',
          name: 'Default Workspace',
          description: 'desc',
          rootFolder: '/',
          created: 1000,
          lastAccessed: 2000,
          isActive: true
        });
      adapter.getWorkspaces.mockResolvedValue({
        items: [{
          id: 'ws-existing-default',
          name: 'Default Workspace',
          description: 'desc',
          rootFolder: '/',
          created: 1000,
          lastAccessed: 2000,
          isActive: true
        }],
        page: 0,
        pageSize: 100,
        totalItems: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false
      });

      const service = new WorkspaceService(plugin, fs, idx, adapter);
      const result = await service.createWorkspace({
        id: 'default',
        name: 'Default Workspace',
        rootFolder: '/'
      });

      expect(result.id).toBe('ws-existing-default');
      expect(adapter.createWorkspace).toHaveBeenCalled();
      expect(adapter.getWorkspaces).toHaveBeenCalled();
    });

    it('deleteWorkspace delegates to adapter.deleteWorkspace', async () => {
      const fs = createMockFileSystem();
      const idx = createMockIndexManager();
      const adapter = createMockAdapter(true);

      const service = new WorkspaceService(plugin, fs, idx, adapter);
      await service.deleteWorkspace('ws-to-delete');

      expect(adapter.deleteWorkspace).toHaveBeenCalledWith('ws-to-delete');
      expect(fs.deleteWorkspace).not.toHaveBeenCalled();
      expect(idx.removeWorkspaceFromIndex).not.toHaveBeenCalled();
    });

    it('getWorkspace returns IndividualWorkspace with empty sessions from adapter', async () => {
      const fs = createMockFileSystem();
      const idx = createMockIndexManager();
      const adapter = createMockAdapter(true);
      adapter.getWorkspace.mockResolvedValue({
        id: 'ws1', name: 'WS', description: 'desc', rootFolder: '/',
        created: 1000, lastAccessed: 2000, isActive: true,
      });

      const service = new WorkspaceService(plugin, fs, idx, adapter);
      const result = await service.getWorkspace('ws1');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('ws1');
      // Characterization: adapter path always returns empty sessions object
      expect(result?.sessions).toEqual({});
    });
  });

  describe('when adapter is NOT ready (legacy path)', () => {
    it('listWorkspaces falls back to indexManager', async () => {
      const fs = createMockFileSystem();
      const idx = createMockIndexManager();
      const adapter = createMockAdapter(false);

      idx.loadWorkspaceIndex.mockResolvedValue({
        workspaces: {
          ws1: { id: 'ws1', name: 'Legacy WS', description: '', rootFolder: '/', created: 1000, lastAccessed: 2000, isActive: true, sessionCount: 3, traceCount: 5 },
        },
        byName: {}, byDescription: {}, byFolder: {},
      });

      const service = new WorkspaceService(plugin, fs, idx, adapter);
      const result = await service.listWorkspaces();

      expect(adapter.getWorkspaces).not.toHaveBeenCalled();
      expect(idx.loadWorkspaceIndex).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Legacy WS');
      // Characterization: legacy path preserves sessionCount/traceCount from index
      expect(result[0].sessionCount).toBe(3);
    });

    it('createWorkspace uses fileSystem.writeWorkspace + indexManager', async () => {
      const fs = createMockFileSystem();
      const idx = createMockIndexManager();
      const adapter = createMockAdapter(false);

      const service = new WorkspaceService(plugin, fs, idx, adapter);
      const result = await service.createWorkspace({ name: 'Legacy New' });

      expect(adapter.createWorkspace).not.toHaveBeenCalled();
      expect(fs.writeWorkspace).toHaveBeenCalled();
      expect(idx.updateWorkspaceInIndex).toHaveBeenCalled();
      expect(result.name).toBe('Legacy New');
      expect(result.sessions).toEqual({});
    });

    it('deleteWorkspace uses fileSystem + indexManager', async () => {
      const fs = createMockFileSystem();
      const idx = createMockIndexManager();
      const adapter = createMockAdapter(false);

      const service = new WorkspaceService(plugin, fs, idx, adapter);
      await service.deleteWorkspace('ws-legacy');

      expect(adapter.deleteWorkspace).not.toHaveBeenCalled();
      expect(fs.deleteWorkspace).toHaveBeenCalledWith('ws-legacy');
      expect(idx.removeWorkspaceFromIndex).toHaveBeenCalledWith('ws-legacy');
    });

    it('getWorkspace returns null when workspace not found', async () => {
      const fs = createMockFileSystem();
      const idx = createMockIndexManager();
      fs.readWorkspace.mockResolvedValue(null);

      const service = new WorkspaceService(plugin, fs, idx, undefined);
      const result = await service.getWorkspace('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('adapter getter function pattern', () => {
    it('supports getter function that lazily resolves adapter', async () => {
      const fs = createMockFileSystem();
      const idx = createMockIndexManager();
      const adapter = createMockAdapter(true);
      adapter.getWorkspaces.mockResolvedValue({
        items: [{ id: 'ws1', name: 'Lazy WS', description: '', rootFolder: '/', created: 1000, lastAccessed: 2000, isActive: true }],
        page: 0, pageSize: 100, totalItems: 1, totalPages: 1, hasNextPage: false,
      });

      // Pass a getter function instead of direct adapter
      const getter = () => adapter;
      const service = new WorkspaceService(plugin, fs, idx, getter);
      const result = await service.listWorkspaces();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Lazy WS');
    });

    it('falls back to legacy when getter returns undefined', async () => {
      const fs = createMockFileSystem();
      const idx = createMockIndexManager();

      const getter = () => undefined;
      const service = new WorkspaceService(plugin, fs, idx, getter);
      await service.listWorkspaces();

      expect(idx.loadWorkspaceIndex).toHaveBeenCalled();
    });
  });
});

// ============================================================================
// ConversationService: Dual-Backend Characterization
// ============================================================================

describe('ConversationService dual-backend characterization', () => {
  const plugin = createMockPlugin();

  describe('when adapter IS ready (adapter path)', () => {
    it('listConversations delegates to adapter.getConversations', async () => {
      const fs = createMockFileSystem();
      const idx = createMockIndexManager();
      const adapter = createMockAdapter(true);

      adapter.getConversations.mockResolvedValue({
        items: [
          { id: 'conv1', title: 'Conversation 1', created: 1000, updated: 2000, messageCount: 5 },
        ],
        page: 0, pageSize: 100, totalItems: 1, totalPages: 1, hasNextPage: false,
      });

      const service = new ConversationService(plugin, fs, idx, adapter);
      const result = await service.listConversations();

      expect(adapter.getConversations).toHaveBeenCalled();
      expect(idx.loadConversationIndex).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });

    it('getConversation returns null when conversation not found', async () => {
      const fs = createMockFileSystem();
      const idx = createMockIndexManager();
      const adapter = createMockAdapter(true);
      adapter.getConversation.mockResolvedValue(null);

      const service = new ConversationService(plugin, fs, idx, adapter);
      const result = await service.getConversation('nonexistent');

      expect(result).toBeNull();
      expect(fs.readConversation).not.toHaveBeenCalled();
    });

    it('updateConversation deletes adapter-backed messages that were removed from the conversation', async () => {
      const fs = createMockFileSystem();
      const idx = createMockIndexManager();
      const adapter = createMockAdapter(true);

      adapter.getConversation.mockResolvedValue({
        id: 'conv1',
        title: 'Conversation 1',
        created: 1000,
        updated: 2000,
        messageCount: 3,
        metadata: {}
      });
      adapter.getMessages.mockResolvedValue({
        items: [
          { id: 'msg_keep', role: 'assistant', content: 'keep', timestamp: 1000, state: 'complete' },
          { id: 'msg_delete', role: 'assistant', content: 'delete', timestamp: 1001, state: 'complete' }
        ],
        page: 0,
        pageSize: 200,
        totalItems: 2,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false
      });

      const service = new ConversationService(plugin, fs, idx, adapter);
      await service.updateConversation('conv1', {
        messages: [
          {
            id: 'msg_keep',
            role: 'assistant',
            content: 'updated keep',
            timestamp: 1000,
            conversationId: 'conv1',
            state: 'complete'
          }
        ]
      });

      expect(adapter.deleteMessage).toHaveBeenCalledWith('conv1', 'msg_delete');
      expect(adapter.updateMessage).toHaveBeenCalledWith('conv1', 'msg_keep', expect.objectContaining({
        content: 'updated keep',
        state: 'complete'
      }));
    });
  });

  describe('when adapter is NOT ready (legacy path)', () => {
    it('listConversations falls back to indexManager', async () => {
      const fs = createMockFileSystem();
      const idx = createMockIndexManager();
      const adapter = createMockAdapter(false);

      idx.loadConversationIndex.mockResolvedValue({
        conversations: {
          conv1: { id: 'conv1', title: 'Legacy Conv', created: 1000, updated: 2000, message_count: 3 },
        },
      });

      const service = new ConversationService(plugin, fs, idx, adapter);
      const result = await service.listConversations();

      expect(adapter.getConversations).not.toHaveBeenCalled();
      expect(idx.loadConversationIndex).toHaveBeenCalled();
      expect(result).toHaveLength(1);
    });

    it('getConversation falls back to fileSystem.readConversation', async () => {
      const fs = createMockFileSystem();
      const idx = createMockIndexManager();
      fs.readConversation.mockResolvedValue({
        id: 'conv1',
        title: 'Legacy Conversation',
        messages: [{ role: 'user', content: 'hello', state: 'complete' }],
        created: 1000,
        updated: 2000,
      });

      const service = new ConversationService(plugin, fs, idx, undefined);
      const result = await service.getConversation('conv1');

      expect(result).not.toBeNull();
      expect(fs.readConversation).toHaveBeenCalledWith('conv1');
    });
  });
});

// ============================================================================
// MemoryService: Dual-Backend Characterization
// ============================================================================

describe('MemoryService dual-backend characterization', () => {
  const plugin = createMockPlugin();

  type WorkspaceServiceLike = {
    getWorkspace: jest.Mock;
    getMemoryTraces: jest.Mock;
    addSession?: jest.Mock;
    addMemoryTrace?: jest.Mock;
  };

  describe('when adapter IS ready (adapter path)', () => {
    it('getMemoryTraces delegates to adapter.getTraces', async () => {
      const ws = { getWorkspace: jest.fn(), getMemoryTraces: jest.fn() } as WorkspaceServiceLike;
      const adapter = createMockAdapter(true);
      adapter.getTraces.mockResolvedValue({
        items: [
          { id: 't1', workspaceId: 'ws1', sessionId: 's1', timestamp: 1000, type: 'action', content: 'test' },
        ],
        page: 0, pageSize: 100, totalItems: 1, totalPages: 1, hasNextPage: false,
      });

      const service = new MemoryService(plugin, ws, adapter);
      const result = await service.getMemoryTraces('ws1', 's1');

      expect(adapter.getTraces).toHaveBeenCalledWith('ws1', 's1', undefined);
      expect(ws.getMemoryTraces).not.toHaveBeenCalled();
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('t1');
    });

    it('getStates preserves adapter metadata needed for tags and session display', async () => {
      const ws = { getWorkspace: jest.fn(), getMemoryTraces: jest.fn() } as WorkspaceServiceLike;
      const adapter = createMockAdapter(true);
      adapter.getStates.mockResolvedValue({
        items: [
          {
            id: 'state-1',
            workspaceId: 'ws1',
            sessionId: 'session-1',
            name: 'Verification checkpoint',
            description: 'Checkpoint description',
            created: 1000,
            tags: ['test', 'verification']
          }
        ],
        page: 0,
        pageSize: 100,
        totalItems: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false
      });

      const service = new MemoryService(plugin, ws, adapter);
      const result = await service.getStates('ws1', 'session-1');

      expect(result.items[0]).toEqual(expect.objectContaining({
        id: 'state-1',
        name: 'Verification checkpoint',
        description: 'Checkpoint description',
        sessionId: 'session-1',
        workspaceId: 'ws1',
        tags: ['test', 'verification']
      }));
      expect(result.items[0].state.state?.metadata.tags).toEqual(['test', 'verification']);
    });

    it('getStates backfills missing tag metadata from full state content', async () => {
      const ws = { getWorkspace: jest.fn(), getMemoryTraces: jest.fn() } as WorkspaceServiceLike;
      const adapter = createMockAdapter(true);
      adapter.getStates.mockResolvedValue({
        items: [
          {
            id: 'state-1',
            workspaceId: 'ws1',
            sessionId: 'session-1',
            name: 'Verification checkpoint',
            created: 1000
          }
        ],
        page: 0,
        pageSize: 100,
        totalItems: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false
      });
      adapter.getState.mockResolvedValue({
        id: 'state-1',
        workspaceId: 'ws1',
        sessionId: 'session-1',
        name: 'Verification checkpoint',
        created: 1000,
        content: {
          id: 'state-1',
          name: 'Verification checkpoint',
          workspaceId: 'ws1',
          sessionId: 'session-1',
          created: 1000,
          context: {
            workspaceContext: { purpose: 'Testing' },
            conversationContext: 'Diagnostic context',
            activeTask: 'Verify state metadata',
            activeFiles: [],
            nextSteps: []
          },
          state: {
            workspace: null,
            recentTraces: [],
            contextFiles: [],
            metadata: {
              tags: ['test', 'verification']
            }
          }
        }
      });

      const service = new MemoryService(plugin, ws, adapter);
      const result = await service.getStates('ws1');

      expect(adapter.getState).toHaveBeenCalledWith('state-1');
      expect(result.items[0].tags).toEqual(['test', 'verification']);
      expect(result.items[0].state.state?.metadata.tags).toEqual(['test', 'verification']);
    });

    it('recordActivityTrace creates the missing adapter session with the same generated ID', async () => {
      const ws = { getWorkspace: jest.fn(), getMemoryTraces: jest.fn() } as WorkspaceServiceLike;
      const adapter = createMockAdapter(true);
      adapter.addTrace
        .mockRejectedValueOnce(new Error('session not found'))
        .mockResolvedValueOnce('trace-1');

      const service = new MemoryService(plugin, ws, adapter);
      const result = await service.recordActivityTrace({
        workspaceId: 'ws1',
        timestamp: 1000,
        type: 'action',
        content: 'created from diagnostic'
      });

      const createdSessionId = adapter.createSession.mock.calls[0][1].id;
      expect(createdSessionId).toMatch(/^session_/);
      expect(adapter.createSession).toHaveBeenCalledWith('ws1', expect.objectContaining({
        id: createdSessionId
      }));
      expect(adapter.addTrace).toHaveBeenNthCalledWith(2, 'ws1', createdSessionId, expect.objectContaining({
        content: 'created from diagnostic'
      }));
      expect(result).toBe('trace-1');
    });

    it('createMemoryTrace reuses one generated session ID for save and reload', async () => {
      const ws = { getWorkspace: jest.fn(), getMemoryTraces: jest.fn() } as WorkspaceServiceLike;
      const adapter = createMockAdapter(true);
      adapter.addTrace.mockResolvedValue('trace-1');
      adapter.getTraces.mockImplementation((_workspaceId, sessionId) => Promise.resolve({
        items: [
          {
            id: 'trace-1',
            workspaceId: 'ws1',
            sessionId,
            timestamp: 1000,
            type: 'action',
            content: 'created from diagnostic'
          }
        ],
        page: 0,
        pageSize: 100,
        totalItems: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false
      }));

      const service = new MemoryService(plugin, ws, adapter);
      const result = await service.createMemoryTrace({
        workspaceId: 'ws1',
        timestamp: 1000,
        type: 'action',
        content: 'created from diagnostic'
      });

      const savedSessionId = adapter.addTrace.mock.calls[0][1];
      expect(savedSessionId).toMatch(/^session_/);
      expect(adapter.getTraces).toHaveBeenCalledWith('ws1', savedSessionId, undefined);
      expect(result.sessionId).toBe(savedSessionId);
      expect(result.id).toBe('trace-1');
    });
  });

  describe('when adapter is NOT ready (legacy path)', () => {
    it('getMemoryTraces falls back to workspaceService', async () => {
      const ws = {
        getWorkspace: jest.fn(),
        getMemoryTraces: jest.fn().mockResolvedValue([
          { id: 't1', timestamp: 1000, type: 'action', content: 'legacy trace' },
        ]),
      } as WorkspaceServiceLike;
      const adapter = createMockAdapter(false);

      const service = new MemoryService(plugin, ws, adapter);
      const result = await service.getMemoryTraces('ws1', 's1');

      expect(ws.getMemoryTraces).toHaveBeenCalledWith('ws1', 's1');
      expect(adapter.getTraces).not.toHaveBeenCalled();
      expect(result.items).toHaveLength(1);
      expect(result.items[0].content).toBe('legacy trace');
    });
  });
});

describe('WorkspaceStateService adapter path', () => {
  it('persists state tags and preserves the provided unique session ID', async () => {
    const adapter = createMockAdapter(true);
    const sessionDeps = {
      getSession: jest.fn().mockResolvedValue(null),
      addSession: jest.fn().mockResolvedValue({ id: 'session-1' })
    };
    const service = new WorkspaceStateService(
      createMockFileSystem(),
      createMockIndexManager(),
      adapter,
      sessionDeps
    );

    await service.addState('ws1', 'session-1', {
      id: 'state-1',
      name: 'Verification checkpoint',
      created: 1000,
      state: {
        id: 'state-1',
        name: 'Verification checkpoint',
        workspaceId: 'ws1',
        sessionId: 'session-1',
        created: 1000,
        context: {
          workspaceContext: { purpose: 'Testing' },
          conversationContext: 'Diagnostic context',
          activeTask: 'Verify state metadata',
          activeFiles: [],
          nextSteps: []
        },
        state: {
          workspace: null,
          recentTraces: [],
          contextFiles: [],
          metadata: {
            tags: ['test', 'verification']
          }
        }
      }
    });

    expect(sessionDeps.addSession).toHaveBeenCalledWith('ws1', expect.objectContaining({
      id: 'session-1'
    }));
    expect(adapter.saveState).toHaveBeenCalledWith('ws1', 'session-1', expect.objectContaining({
      tags: ['test', 'verification']
    }));
  });

  it('replaces reserved fallback session IDs with generated unique IDs before saving', async () => {
    const adapter = createMockAdapter(true);
    const sessionDeps = {
      getSession: jest.fn().mockResolvedValue(null),
      addSession: jest.fn().mockResolvedValue({ id: 'session-generated' })
    };
    const service = new WorkspaceStateService(
      createMockFileSystem(),
      createMockIndexManager(),
      adapter,
      sessionDeps
    );

    await service.addState('ws1', 'default-session', {
      id: 'state-1',
      name: 'Verification checkpoint',
      created: 1000,
      state: {
        id: 'state-1',
        name: 'Verification checkpoint',
        workspaceId: 'ws1',
        sessionId: 'default-session',
        created: 1000,
        context: {
          workspaceContext: { purpose: 'Testing' },
          conversationContext: 'Diagnostic context',
          activeTask: 'Verify state metadata',
          activeFiles: [],
          nextSteps: []
        }
      }
    });

    expect(sessionDeps.addSession).toHaveBeenCalledWith('ws1', expect.objectContaining({
      id: expect.stringMatching(/^session_/)
    }));
    expect(adapter.saveState).toHaveBeenCalledWith('ws1', 'session-generated', expect.objectContaining({
      name: 'Verification checkpoint'
    }));
  });
});
