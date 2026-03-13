/**
 * WorkspacePromptResolver Unit Tests
 *
 * Tests for the SQLite-backed prompt resolution (PR #46) with fallback to data.json.
 * Verifies CustomPromptStorageService integration, fallback chain, and backward
 * compatibility with legacy workspace structures.
 */

// ============================================================================
// Module Mocks
// ============================================================================

jest.mock('obsidian', () => ({}), { virtual: true });

// ============================================================================
// Imports
// ============================================================================

import { WorkspacePromptResolver, WorkspacePromptInfo } from '../../src/agents/memoryManager/services/WorkspacePromptResolver';

// ============================================================================
// Mock Factories
// ============================================================================

function createMockPlugin(prompts: Array<{ id: string; name: string; prompt: string }> = []) {
  return {
    settings: {
      settings: {
        customPrompts: {
          prompts,
        },
      },
    },
  };
}

function createMockCustomPromptStorage(prompts: Map<string, { id: string; name: string; prompt: string }> = new Map()) {
  return {
    getPromptByNameOrId: jest.fn((identifier: string) => {
      // Check by ID first, then by name
      for (const p of prompts.values()) {
        if (p.id === identifier || p.name === identifier) {
          return p;
        }
      }
      return null;
    }),
  };
}

function createMockApp() {
  return {} as any;
}

// ============================================================================
// Tests
// ============================================================================

describe('WorkspacePromptResolver', () => {
  describe('constructor', () => {
    it('should accept optional customPromptStorage', () => {
      const resolver = new WorkspacePromptResolver(createMockApp(), createMockPlugin());
      expect(resolver).toBeDefined();
    });

    it('should accept customPromptStorage when provided', () => {
      const storage = createMockCustomPromptStorage();
      const resolver = new WorkspacePromptResolver(createMockApp(), createMockPlugin(), storage as any);
      expect(resolver).toBeDefined();
    });
  });

  describe('fetchPromptByNameOrId — SQLite primary path', () => {
    it('should use CustomPromptStorageService when available', async () => {
      const sqlitePrompts = new Map([
        ['abc', { id: 'abc', name: 'My Prompt', prompt: 'You are helpful.' }],
      ]);
      const storage = createMockCustomPromptStorage(sqlitePrompts);
      const resolver = new WorkspacePromptResolver(createMockApp(), createMockPlugin(), storage as any);

      const result = await resolver.fetchPromptByNameOrId('abc', createMockApp());

      expect(storage.getPromptByNameOrId).toHaveBeenCalledWith('abc');
      expect(result).toEqual({
        id: 'abc',
        name: 'My Prompt',
        systemPrompt: 'You are helpful.',
      });
    });

    it('should resolve by name via CustomPromptStorageService', async () => {
      const sqlitePrompts = new Map([
        ['abc', { id: 'abc', name: 'My Prompt', prompt: 'You are helpful.' }],
      ]);
      const storage = createMockCustomPromptStorage(sqlitePrompts);
      const resolver = new WorkspacePromptResolver(createMockApp(), createMockPlugin(), storage as any);

      const result = await resolver.fetchPromptByNameOrId('My Prompt', createMockApp());

      expect(result).toEqual({
        id: 'abc',
        name: 'My Prompt',
        systemPrompt: 'You are helpful.',
      });
    });

    it('should NOT fall back to data.json if service finds the prompt', async () => {
      const sqlitePrompts = new Map([
        ['abc', { id: 'abc', name: 'SQLite Prompt', prompt: 'From SQLite' }],
      ]);
      const storage = createMockCustomPromptStorage(sqlitePrompts);

      // data.json has a different prompt with the same ID
      const plugin = createMockPlugin([
        { id: 'abc', name: 'JSON Prompt', prompt: 'From JSON' },
      ]);

      const resolver = new WorkspacePromptResolver(createMockApp(), plugin, storage as any);
      const result = await resolver.fetchPromptByNameOrId('abc', createMockApp());

      // SQLite takes priority
      expect(result?.systemPrompt).toBe('From SQLite');
    });
  });

  describe('fetchPromptByNameOrId — data.json fallback', () => {
    it('should fall back to data.json when service is unavailable', async () => {
      const plugin = createMockPlugin([
        { id: 'xyz', name: 'Fallback Prompt', prompt: 'From data.json' },
      ]);

      // No storage service
      const resolver = new WorkspacePromptResolver(createMockApp(), plugin);
      const result = await resolver.fetchPromptByNameOrId('xyz', createMockApp());

      expect(result).toEqual({
        id: 'xyz',
        name: 'Fallback Prompt',
        systemPrompt: 'From data.json',
      });
    });

    it('should fall back to data.json when service returns null', async () => {
      const storage = createMockCustomPromptStorage(new Map()); // empty
      const plugin = createMockPlugin([
        { id: 'xyz', name: 'Fallback', prompt: 'From JSON' },
      ]);

      const resolver = new WorkspacePromptResolver(createMockApp(), plugin, storage as any);
      const result = await resolver.fetchPromptByNameOrId('xyz', createMockApp());

      expect(storage.getPromptByNameOrId).toHaveBeenCalledWith('xyz');
      expect(result?.systemPrompt).toBe('From JSON');
    });

    it('should try ID lookup before name lookup in data.json fallback', async () => {
      const plugin = createMockPlugin([
        { id: 'name-match', name: 'id-match', prompt: 'By name' },
        { id: 'id-match', name: 'Other', prompt: 'By ID' },
      ]);

      const resolver = new WorkspacePromptResolver(createMockApp(), plugin);
      const result = await resolver.fetchPromptByNameOrId('id-match', createMockApp());

      // ID match should take priority
      expect(result?.systemPrompt).toBe('By ID');
    });

    it('should return null when prompt not found anywhere', async () => {
      const storage = createMockCustomPromptStorage(new Map());
      const plugin = createMockPlugin([]);

      const resolver = new WorkspacePromptResolver(createMockApp(), plugin, storage as any);
      const result = await resolver.fetchPromptByNameOrId('nonexistent', createMockApp());

      expect(result).toBeNull();
    });
  });

  describe('fetchWorkspacePrompt — workspace resolution', () => {
    it('should use dedicatedAgentId from top-level workspace field', async () => {
      const sqlitePrompts = new Map([
        ['agent-1', { id: 'agent-1', name: 'Agent', prompt: 'Prompt content' }],
      ]);
      const storage = createMockCustomPromptStorage(sqlitePrompts);
      const resolver = new WorkspacePromptResolver(createMockApp(), createMockPlugin(), storage as any);

      const workspace = {
        id: 'ws-1',
        name: 'Test',
        dedicatedAgentId: 'agent-1',
        context: {},
      } as any;

      const result = await resolver.fetchWorkspacePrompt(workspace, createMockApp());
      expect(result?.id).toBe('agent-1');
    });

    it('should fall back to context.dedicatedAgent (deprecated)', async () => {
      const plugin = createMockPlugin([
        { id: 'old-agent', name: 'Old Agent', prompt: 'Legacy prompt' },
      ]);
      const resolver = new WorkspacePromptResolver(createMockApp(), plugin);

      const workspace = {
        id: 'ws-1',
        name: 'Test',
        context: {
          dedicatedAgent: { agentId: 'old-agent' },
        },
      } as any;

      const result = await resolver.fetchWorkspacePrompt(workspace, createMockApp());
      expect(result?.id).toBe('old-agent');
    });

    it('should fall back to legacy agents array (pre-v4)', async () => {
      const plugin = createMockPlugin([
        { id: 'legacy-id', name: 'Legacy Agent', prompt: 'Very old prompt' },
      ]);
      const resolver = new WorkspacePromptResolver(createMockApp(), plugin);

      const workspace = {
        id: 'ws-1',
        name: 'Test',
        context: {
          agents: [{ name: 'Legacy Agent' }],
        },
      } as any;

      const result = await resolver.fetchWorkspacePrompt(workspace, createMockApp());
      expect(result?.name).toBe('Legacy Agent');
    });

    it('should return null for workspace with no prompt references', async () => {
      const resolver = new WorkspacePromptResolver(createMockApp(), createMockPlugin());

      const workspace = {
        id: 'ws-1',
        name: 'Test',
        context: {},
      } as any;

      const result = await resolver.fetchWorkspacePrompt(workspace, createMockApp());
      expect(result).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should return null on exception and not throw', async () => {
      const storage = {
        getPromptByNameOrId: jest.fn(() => { throw new Error('DB crash'); }),
      };

      const resolver = new WorkspacePromptResolver(createMockApp(), createMockPlugin(), storage as any);
      const result = await resolver.fetchPromptByNameOrId('test', createMockApp());

      // Should catch and return null, not throw
      expect(result).toBeNull();
    });

    it('should handle null/undefined plugin gracefully', async () => {
      const resolver = new WorkspacePromptResolver(createMockApp(), null);
      const result = await resolver.fetchPromptByNameOrId('test', createMockApp());
      expect(result).toBeNull();
    });
  });
});
