/**
 * SearchMemory Tool Unit Tests
 *
 * Tests the parameter schema, type definitions, and execute() behavior
 * for the searchMemory tool.
 *
 * Schema tests verify the tool's contract with external callers (e.g., Claude Desktop via MCP).
 * Execute tests verify actionable guidance on empty results, degraded search nudges,
 * and normal result formatting via an injected mock processor.
 */

import { SearchMemoryTool, MemoryType, SearchMemoryParams } from '../../src/agents/searchManager/tools/searchMemory';
import { MemorySearchProcessorInterface, SearchProcessResult, SearchMetadata } from '../../src/agents/searchManager/services/MemorySearchProcessor';
import { GLOBAL_WORKSPACE_ID } from '../../src/services/WorkspaceService';

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

    it('should not require workspaceId parameter (defaults to global workspace)', () => {
      const required = schema.required || [];
      expect(required).not.toContain('workspaceId');
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

  // ==========================================================================
  // Execute Behavior (mock processor injection)
  // ==========================================================================

  describe('execute() behavior', () => {
    let execTool: SearchMemoryTool;
    let mockProcessor: MemorySearchProcessorInterface;

    // Reusable mock enriched result for tests that need non-empty results
    const mockConversationResult = {
      type: 'conversation' as const,
      id: 'pair-1',
      highlight: 'auth implementation',
      metadata: {},
      context: { before: '', match: 'auth', after: '' },
      score: 0.9,
      _rawTrace: {
        type: 'conversation',
        conversationId: 'conv-1',
        conversationTitle: 'Test Conv',
        question: 'How do we do auth?',
        answer: 'We use JWT tokens.',
        matchedSide: 'question',
        pairType: 'conversation_turn'
      }
    };

    beforeEach(() => {
      mockProcessor = {
        process: jest.fn(),
        validateParameters: jest.fn(),
        executeSearch: jest.fn(),
        enrichResults: jest.fn(),
        getConfiguration: jest.fn(),
        updateConfiguration: jest.fn()
      };

      // Inject mock processor via constructor's 5th parameter
      execTool = new SearchMemoryTool(
        {} as any,        // plugin
        undefined,         // memoryService
        undefined,         // workspaceService
        undefined,         // storageAdapter
        mockProcessor      // processor
      );
    });

    // Helper to build standard params
    function makeParams(overrides: Partial<SearchMemoryParams> = {}): SearchMemoryParams {
      return {
        query: 'test query',
        workspaceId: 'ws-1',
        context: { workspaceId: 'ws-1', sessionId: '', memory: '', goal: '' },
        ...overrides
      };
    }

    it('should return actionable guidance when no results are found', async () => {
      (mockProcessor.process as jest.Mock).mockResolvedValue({
        results: [],
        metadata: { typesSearched: ['traces', 'states', 'conversations'], typesUnavailable: [], typesFailed: [] }
      });

      const result = await execTool.execute(makeParams());

      expect(result.success).toBe(false);
      expect(result.error).toContain('No results found');
      expect(result.error).toContain('broader or rephrased search terms');
    });

    it('should mention unavailable types in guidance when conversations search was unavailable', async () => {
      (mockProcessor.process as jest.Mock).mockResolvedValue({
        results: [],
        metadata: { typesSearched: ['traces', 'states'], typesUnavailable: ['conversations'], typesFailed: [] }
      });

      const result = await execTool.execute(makeParams());

      expect(result.success).toBe(false);
      expect(result.error).toContain('conversations search was unavailable');
      expect(result.error).toContain('only traces, states were searched');
    });

    it('should suggest removing sessionId when scoped search returns empty', async () => {
      (mockProcessor.process as jest.Mock).mockResolvedValue({
        results: [],
        metadata: { typesSearched: ['conversations'], typesUnavailable: [], typesFailed: [] }
      });

      const result = await execTool.execute(makeParams({
        sessionId: 'sess-1',
        context: { workspaceId: 'ws-1', sessionId: 'sess-1', memory: '', goal: '' }
      }));

      expect(result.success).toBe(false);
      expect(result.error).toContain('Remove sessionId');
    });

    it('should warn about failed types in guidance', async () => {
      (mockProcessor.process as jest.Mock).mockResolvedValue({
        results: [],
        metadata: { typesSearched: ['traces'], typesUnavailable: [], typesFailed: ['conversations'] }
      });

      const result = await execTool.execute(makeParams());

      expect(result.success).toBe(false);
      expect(result.error).toContain('search failed for conversations');
    });

    it('should include partial_search nudge when results exist but some types were unavailable', async () => {
      (mockProcessor.process as jest.Mock).mockResolvedValue({
        results: [mockConversationResult],
        metadata: { typesSearched: ['traces'], typesUnavailable: ['conversations'], typesFailed: [] }
      });

      const result = await execTool.execute(makeParams({ query: 'auth' }));

      expect(result.success).toBe(true);
      expect(result.recommendations).toBeDefined();
      const partialNudge = (result as any).recommendations?.find((r: any) => r.type === 'partial_search');
      expect(partialNudge).toBeDefined();
      expect(partialNudge.message).toContain('conversations search was unavailable');
    });

    it('should include search_error nudge when results exist but some types failed', async () => {
      (mockProcessor.process as jest.Mock).mockResolvedValue({
        results: [mockConversationResult],
        metadata: { typesSearched: ['traces'], typesUnavailable: [], typesFailed: ['states'] }
      });

      const result = await execTool.execute(makeParams({ query: 'auth' }));

      expect(result.success).toBe(true);
      const errorNudge = (result as any).recommendations?.find((r: any) => r.type === 'search_error');
      expect(errorNudge).toBeDefined();
      expect(errorNudge.message).toContain('Search failed for states');
    });

    it('should return clean results with no degraded nudges when all types searched successfully', async () => {
      (mockProcessor.process as jest.Mock).mockResolvedValue({
        results: [mockConversationResult],
        metadata: { typesSearched: ['traces', 'states', 'conversations'], typesUnavailable: [], typesFailed: [] }
      });

      const result = await execTool.execute(makeParams({ query: 'auth' }));

      expect(result.success).toBe(true);
      expect((result as any).data?.results).toHaveLength(1);
      expect((result as any).data?.results[0]).toHaveProperty('type', 'conversation');
      expect((result as any).data?.results[0]).toHaveProperty('question', 'How do we do auth?');
      expect((result as any).data?.results[0]).toHaveProperty('answer', 'We use JWT tokens.');

      // No partial_search or search_error nudges
      const partialNudge = (result as any).recommendations?.find((r: any) => r.type === 'partial_search');
      expect(partialNudge).toBeUndefined();
      const errorNudge = (result as any).recommendations?.find((r: any) => r.type === 'search_error');
      expect(errorNudge).toBeUndefined();
    });

    it('should default workspaceId to GLOBAL_WORKSPACE_ID when omitted', async () => {
      (mockProcessor.process as jest.Mock).mockResolvedValue({
        results: [],
        metadata: { typesSearched: ['traces', 'states', 'conversations'], typesUnavailable: [], typesFailed: [] }
      });

      await execTool.execute({
        query: 'test',
        context: { workspaceId: '', sessionId: '', memory: '', goal: '' }
      } as any);

      expect(mockProcessor.process).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: GLOBAL_WORKSPACE_ID })
      );
    });

    it('should return error for empty query', async () => {
      const result = await execTool.execute(makeParams({ query: '' }));

      expect(result.success).toBe(false);
      expect(result.error).toContain('Query parameter is required');
      expect(mockProcessor.process).not.toHaveBeenCalled();
    });

    it('should format conversation results with windowed messages in scoped mode', async () => {
      const scopedResult = {
        ...mockConversationResult,
        _rawTrace: {
          ...mockConversationResult._rawTrace,
          windowMessages: [
            { role: 'user', content: 'Previous question', sequenceNumber: 1 },
            { role: 'assistant', content: 'Previous answer', sequenceNumber: 2 },
            { role: 'user', content: 'How do we do auth?', sequenceNumber: 3 }
          ]
        }
      };

      (mockProcessor.process as jest.Mock).mockResolvedValue({
        results: [scopedResult],
        metadata: { typesSearched: ['conversations'], typesUnavailable: [], typesFailed: [] }
      });

      const result = await execTool.execute(makeParams({ sessionId: 'sess-1' }));

      expect(result.success).toBe(true);
      const firstResult = (result as any).data?.results[0];
      expect(firstResult.windowMessages).toHaveLength(3);
      expect(firstResult.windowMessages[0]).toEqual({
        role: 'user',
        content: 'Previous question',
        sequenceNumber: 1
      });
    });

    it('should handle processor errors gracefully', async () => {
      (mockProcessor.process as jest.Mock).mockRejectedValue(new Error('Database connection lost'));

      const result = await execTool.execute(makeParams());

      expect(result.success).toBe(false);
      expect(result.error).toContain('Memory search failed');
      expect(result.error).toContain('Database connection lost');
    });

    it('should filter out null results from malformed traces', async () => {
      const resultWithNoTrace = {
        type: 'conversation' as const,
        id: 'pair-2',
        highlight: 'test',
        metadata: {},
        context: { before: '', match: 'test', after: '' },
        score: 0.5,
        // Missing _rawTrace -- will produce null during formatting
      };

      (mockProcessor.process as jest.Mock).mockResolvedValue({
        results: [mockConversationResult, resultWithNoTrace],
        metadata: { typesSearched: ['conversations'], typesUnavailable: [], typesFailed: [] }
      });

      const result = await execTool.execute(makeParams());

      expect(result.success).toBe(true);
      // Only the valid result should survive null filtering
      expect((result as any).data?.results).toHaveLength(1);
      expect((result as any).data?.results[0]).toHaveProperty('type', 'conversation');
    });
  });
});
