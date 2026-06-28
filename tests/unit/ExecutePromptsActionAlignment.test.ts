import type { AgentManager } from '../../src/services/AgentManager';
import { ActionExecutor } from '../../src/agents/promptManager/tools/executePrompts/services/ActionExecutor';
import { PromptParser } from '../../src/agents/promptManager/tools/executePrompts/utils/promptParser';

describe('executePrompts action alignment (pattern anchors)', () => {
  describe('PromptParser replace validation', () => {
    it('accepts replace actions with start and end anchors', () => {
      const parser = new PromptParser();

      const errors = parser.validateActionConfig(
        {
          type: 'replace',
          targetPath: 'notes/demo.md',
          start: '## Header',
          end: '</details>',
        },
        'Request 1'
      );

      expect(errors).toEqual([]);
    });

    it('rejects replace actions missing start', () => {
      const parser = new PromptParser();

      const errors = parser.validateActionConfig(
        {
          type: 'replace',
          targetPath: 'notes/demo.md',
          end: '</details>',
        },
        'Request 1'
      );

      expect(errors).toContain(
        'Request 1: action.start is required for replace and must contain non-whitespace text'
      );
    });

    it('rejects replace actions missing end', () => {
      const parser = new PromptParser();

      const errors = parser.validateActionConfig(
        {
          type: 'replace',
          targetPath: 'notes/demo.md',
          start: '## Header',
        },
        'Request 1'
      );

      expect(errors).toContain(
        'Request 1: action.end is required for replace and must contain non-whitespace text'
      );
    });

    it('rejects whitespace-only start anchor', () => {
      const parser = new PromptParser();

      const errors = parser.validateActionConfig(
        {
          type: 'replace',
          targetPath: 'notes/demo.md',
          start: '   ',
          end: '</details>',
        },
        'Request 1'
      );

      expect(errors).toContain(
        'Request 1: action.start is required for replace and must contain non-whitespace text'
      );
    });
  });

  describe('ActionExecutor routing', () => {
    function createExecutor() {
      const executeAgentTool = jest.fn().mockResolvedValue({ success: true });
      const agentManager = { executeAgentTool } as unknown as AgentManager;
      return {
        executeAgentTool,
        executor: new ActionExecutor(agentManager),
      };
    }

    it('routes append actions through contentManager.insert at startLine -1', async () => {
      const { executor, executeAgentTool } = createExecutor();

      const result = await executor.executeContentAction(
        { type: 'append', targetPath: 'notes/demo.md' },
        'Generated content',
        'session-1',
        'ctx'
      );

      expect(result).toEqual({ success: true, error: undefined });
      expect(executeAgentTool).toHaveBeenCalledWith(
        'contentManager',
        'insert',
        expect.objectContaining({
          path: 'notes/demo.md',
          content: 'Generated content',
          startLine: -1,
          sessionId: 'session-1',
          context: 'ctx',
        })
      );
    });

    it('routes prepend actions through contentManager.insert at startLine 1', async () => {
      const { executor, executeAgentTool } = createExecutor();

      await executor.executeContentAction(
        { type: 'prepend', targetPath: 'notes/demo.md' },
        'Generated content'
      );

      expect(executeAgentTool).toHaveBeenCalledWith(
        'contentManager',
        'insert',
        expect.objectContaining({
          path: 'notes/demo.md',
          content: 'Generated content',
          startLine: 1,
        })
      );
    });

    it('routes replace actions through contentManager.replace with start/end/content', async () => {
      const { executor, executeAgentTool } = createExecutor();

      await executor.executeContentAction(
        {
          type: 'replace',
          targetPath: 'notes/demo.md',
          start: '## Architecture',
          end: '</details>',
        },
        'New body',
        'session-2',
        'ctx-2'
      );

      expect(executeAgentTool).toHaveBeenCalledWith(
        'contentManager',
        'replace',
        {
          path: 'notes/demo.md',
          start: '## Architecture',
          end: '</details>',
          content: 'New body',
          sessionId: 'session-2',
          context: 'ctx-2',
        }
      );
    });

    it('fails fast on replace actions missing anchors before calling agentManager', async () => {
      const { executor, executeAgentTool } = createExecutor();

      const result = await executor.executeContentAction(
        {
          type: 'replace',
          targetPath: 'notes/demo.md',
        },
        'New content'
      );

      expect(result).toEqual({
        success: false,
        error: 'replace action requires both start and end anchors (non-whitespace text)',
      });
      expect(executeAgentTool).not.toHaveBeenCalled();
    });

    it('fails fast when targetPath is missing (validation gate before agentManager)', async () => {
      const { executor, executeAgentTool } = createExecutor();

      const result = await executor.executeContentAction(
        { type: 'replace' } as unknown as Parameters<typeof executor.executeContentAction>[0],
        'New content'
      );

      expect(result).toEqual({
        success: false,
        error: 'Target path is required',
      });
      expect(executeAgentTool).not.toHaveBeenCalled();
    });

    it('fails fast on missing action.type before invoking agentManager', async () => {
      const { executor, executeAgentTool } = createExecutor();

      const result = await executor.executeContentAction(
        { targetPath: 'notes/demo.md' } as unknown as Parameters<typeof executor.executeContentAction>[0],
        'New content'
      );

      expect(result).toEqual({
        success: false,
        error: 'Action type is required',
      });
      expect(executeAgentTool).not.toHaveBeenCalled();
    });

    it('returns "Unknown action type" for an action.type the executor does not recognise', async () => {
      const { executor, executeAgentTool } = createExecutor();

      const result = await executor.executeContentAction(
        {
          type: 'mutate' as unknown as 'replace',
          targetPath: 'notes/demo.md',
        },
        'New content'
      );

      expect(result).toEqual({ success: false, error: 'Unknown action type' });
      expect(executeAgentTool).not.toHaveBeenCalled();
    });

    it('propagates an underlying replace-tool error (non-existent file) through executeContentAction', async () => {
      const executeAgentTool = jest.fn().mockResolvedValue({
        success: false,
        error: 'File not found: "notes/missing.md". Use search content to find files by name, or storageManager.list to explore folders.',
      });
      const agentManager = { executeAgentTool } as unknown as AgentManager;
      const executor = new ActionExecutor(agentManager);

      const result = await executor.executeContentAction(
        {
          type: 'replace',
          targetPath: 'notes/missing.md',
          start: '## Header',
          end: '</details>',
        },
        'body'
      );

      expect(result.success).toBe(false);
      // M3 — plan §6 verbatim file-not-found message must propagate intact
      // (no executor rewrap, no truncation of the storageManager guidance).
      expect(result.error).toBe(
        'File not found: "notes/missing.md". Use search content to find files by name, or storageManager.list to explore folders.'
      );
      expect(executeAgentTool).toHaveBeenCalledTimes(1);
    });

    it('propagates an underlying replace-tool anchor-not-found error through executeContentAction', async () => {
      const executeAgentTool = jest.fn().mockResolvedValue({
        success: false,
        error: 'start anchor not found in file. The content may have shifted since your last read — re-read just the expected line range (contentManager.read with a narrow startLine/endLine), not the whole file, then retry.',
      });
      const agentManager = { executeAgentTool } as unknown as AgentManager;
      const executor = new ActionExecutor(agentManager);

      const result = await executor.executeContentAction(
        {
          type: 'replace',
          targetPath: 'notes/demo.md',
          start: 'missing-anchor',
          end: 'also-missing',
        },
        'body'
      );

      expect(result.success).toBe(false);
      // M3 — plan §6 verbatim start-anchor-not-found message (including the
      // re-read coaching suffix) must propagate through executor unchanged.
      expect(result.error).toBe(
        'start anchor not found in file. The content may have shifted since your last read — re-read just the expected line range (contentManager.read with a narrow startLine/endLine), not the whole file, then retry.'
      );
      expect(executeAgentTool).toHaveBeenCalledWith(
        'contentManager',
        'replace',
        expect.objectContaining({
          path: 'notes/demo.md',
          start: 'missing-anchor',
          end: 'also-missing',
          content: 'body',
        })
      );
    });

    it('reports "Invalid response from replace tool" when the agent returns a non-CommonResult shape', async () => {
      const executeAgentTool = jest.fn().mockResolvedValue('totally-unexpected');
      const agentManager = { executeAgentTool } as unknown as AgentManager;
      const executor = new ActionExecutor(agentManager);

      const result = await executor.executeContentAction(
        {
          type: 'replace',
          targetPath: 'notes/demo.md',
          start: 'A',
          end: 'B',
        },
        'body'
      );

      expect(result).toEqual({
        success: false,
        error: 'Invalid response from replace tool',
      });
    });

    it('reports "Agent manager not available" when no agentManager is wired', async () => {
      const executor = new ActionExecutor(undefined);

      const result = await executor.executeContentAction(
        {
          type: 'replace',
          targetPath: 'notes/demo.md',
          start: 'A',
          end: 'B',
        },
        'body'
      );

      expect(result).toEqual({
        success: false,
        error: 'Agent manager not available',
      });
    });

    it('catches a thrown error from agentManager.executeAgentTool and returns it as an error result', async () => {
      const executeAgentTool = jest.fn().mockRejectedValue(new Error('tool blew up'));
      const agentManager = { executeAgentTool } as unknown as AgentManager;
      const executor = new ActionExecutor(agentManager);

      const result = await executor.executeContentAction(
        {
          type: 'replace',
          targetPath: 'notes/demo.md',
          start: 'A',
          end: 'B',
        },
        'body'
      );

      expect(result).toEqual({
        success: false,
        error: 'tool blew up',
      });
    });
  });
});
