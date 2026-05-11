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
  });
});
