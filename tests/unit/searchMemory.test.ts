/**
 * SearchMemory Tool Unit Tests
 *
 * Tests the parameter schema and type definitions for the searchMemory tool.
 * Validates that the 'conversations' memory type and related parameters
 * (sessionId, windowSize) are properly defined in the schema.
 *
 * This tests the schema definition, not the execution logic (which requires
 * full plugin context). Schema testing verifies the tool's contract with
 * external callers (e.g., Claude Desktop via MCP).
 */

import { SearchMemoryTool, MemoryType, SearchMemoryParams } from '../../src/agents/searchManager/tools/searchMemory';

describe('SearchMemory Tool', () => {
  let tool: SearchMemoryTool;
  let schema: Record<string, any>;

  beforeEach(() => {
    // Create tool with minimal mock dependencies
    // We only need the schema, not execution
    const mockPlugin = {} as any;
    tool = new SearchMemoryTool(mockPlugin);
    schema = tool.getParameterSchema();
  });

  // ==========================================================================
  // Memory Types
  // ==========================================================================

  describe('memoryTypes parameter', () => {
    it('should include conversations as a valid memory type', () => {
      // Find memoryTypes in the schema properties
      // Schema may be merged, so check nested properties
      const props = schema.properties || {};
      const memoryTypes = props.memoryTypes;

      expect(memoryTypes).toBeDefined();
      expect(memoryTypes.type).toBe('array');

      const enumValues = memoryTypes.items?.enum;
      expect(enumValues).toContain('conversations');
    });

    it('should include traces and states as valid memory types', () => {
      const props = schema.properties || {};
      const enumValues = props.memoryTypes?.items?.enum;

      expect(enumValues).toContain('traces');
      expect(enumValues).toContain('states');
    });

    it('should default memoryTypes to all types', () => {
      const props = schema.properties || {};
      const memoryTypes = props.memoryTypes;

      expect(memoryTypes.default).toEqual(['traces', 'states', 'conversations']);
    });
  });

  // ==========================================================================
  // Required Parameters
  // ==========================================================================

  describe('required parameters', () => {
    it('should require query parameter', () => {
      const required = schema.required || [];
      expect(required).toContain('query');
    });

    it('should require workspaceId parameter', () => {
      const required = schema.required || [];
      expect(required).toContain('workspaceId');
    });
  });

  // ==========================================================================
  // Conversation-Specific Parameters
  // ==========================================================================

  describe('conversation search parameters', () => {
    it('should accept sessionId parameter', () => {
      const props = schema.properties || {};
      expect(props.sessionId).toBeDefined();
      expect(props.sessionId.type).toBe('string');
    });

    it('should accept windowSize parameter', () => {
      const props = schema.properties || {};
      expect(props.windowSize).toBeDefined();
      expect(props.windowSize.type).toBe('number');
    });

    it('should set windowSize default to 3', () => {
      const props = schema.properties || {};
      expect(props.windowSize.default).toBe(3);
    });

    it('should set windowSize minimum to 1', () => {
      const props = schema.properties || {};
      expect(props.windowSize.minimum).toBe(1);
    });

    it('should set windowSize maximum to 20', () => {
      const props = schema.properties || {};
      expect(props.windowSize.maximum).toBe(20);
    });

    it('should describe sessionId as optional for scoped search', () => {
      const props = schema.properties || {};
      expect(props.sessionId.description).toBeDefined();
      expect(props.sessionId.description.toLowerCase()).toContain('session');
    });

    it('should describe windowSize as only used in scoped mode', () => {
      const props = schema.properties || {};
      expect(props.windowSize.description).toBeDefined();
      expect(props.windowSize.description.toLowerCase()).toContain('scoped');
    });
  });

  // ==========================================================================
  // Result Schema
  // ==========================================================================

  describe('result schema', () => {
    it('should include conversation result fields', () => {
      const resultSchema = tool.getResultSchema();
      const resultItemProps = resultSchema.properties?.results?.items?.properties;

      expect(resultItemProps).toBeDefined();
      expect(resultItemProps.type).toBeDefined();
      expect(resultItemProps.conversationTitle).toBeDefined();
      expect(resultItemProps.conversationId).toBeDefined();
      expect(resultItemProps.question).toBeDefined();
      expect(resultItemProps.answer).toBeDefined();
      expect(resultItemProps.matchedSide).toBeDefined();
      expect(resultItemProps.pairType).toBeDefined();
      expect(resultItemProps.windowMessages).toBeDefined();
    });

    it('should include matchedSide enum values', () => {
      const resultSchema = tool.getResultSchema();
      const matchedSide = resultSchema.properties?.results?.items?.properties?.matchedSide;

      expect(matchedSide.enum).toEqual(['question', 'answer']);
    });

    it('should include pairType enum values', () => {
      const resultSchema = tool.getResultSchema();
      const pairType = resultSchema.properties?.results?.items?.properties?.pairType;

      expect(pairType.enum).toEqual(['conversation_turn', 'trace_pair']);
    });
  });

  // ==========================================================================
  // TypeScript Type Checks (compile-time + runtime validation)
  // ==========================================================================

  describe('TypeScript type definitions', () => {
    it('should accept conversations as a MemoryType value', () => {
      const validType: MemoryType = 'conversations';
      expect(validType).toBe('conversations');
    });

    it('should accept traces as a MemoryType value', () => {
      const validType: MemoryType = 'traces';
      expect(validType).toBe('traces');
    });

    it('should accept states as a MemoryType value', () => {
      const validType: MemoryType = 'states';
      expect(validType).toBe('states');
    });

    it('should accept SearchMemoryParams with all conversation fields', () => {
      const params: SearchMemoryParams = {
        query: 'test search',
        workspaceId: 'ws-001',
        memoryTypes: ['conversations'],
        sessionId: 'sess-001',
        windowSize: 5,
        context: { workspaceId: 'ws-001', sessionId: 'sess-001', memory: '', goal: '' },
      };

      expect(params.sessionId).toBe('sess-001');
      expect(params.windowSize).toBe(5);
      expect(params.memoryTypes).toContain('conversations');
    });
  });
});
