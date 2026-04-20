import type { AgentManager } from '../../src/services/AgentManager';
import { ActionExecutor } from '../../src/agents/promptManager/tools/executePrompts/services/ActionExecutor';
import { PromptParser } from '../../src/agents/promptManager/tools/executePrompts/utils/promptParser';

describe('executePrompts action alignment', () => {
  describe('PromptParser replace validation', () => {
    it('accepts validated line-range replace actions', () => {
      const parser = new PromptParser();

      const errors = parser.validateActionConfig(
        {
          type: 'replace',
          targetPath: 'notes/demo.md',
          oldContent: 'Old paragraph',
          startLine: 4,
          endLine: 6,
        },
        'Request 1'
      );

      expect(errors).toEqual([]);
    });

    it('rejects partial line-range replace actions', () => {
      const parser = new PromptParser();

      const errors = parser.validateActionConfig(
        {
          type: 'replace',
          targetPath: 'notes/demo.md',
          oldContent: 'Old paragraph',
          startLine: 4,
        },
        'Request 1'
      );

      expect(errors).toContain(
        'Request 1: action.replace line-range mode requires action.oldContent, action.startLine, and action.endLine'
      );
    });

    it('accepts deprecated position only when oldContent is supplied', () => {
      const parser = new PromptParser();

      const errors = parser.validateActionConfig(
        {
          type: 'replace',
          targetPath: 'notes/demo.md',
          oldContent: 'Old line',
          position: 8,
        },
        'Request 1'
      );

      expect(errors).toEqual([]);
    });

    it('rejects deprecated position without oldContent', () => {
      const parser = new PromptParser();

      const errors = parser.validateActionConfig(
        {
          type: 'replace',
          targetPath: 'notes/demo.md',
          position: 8,
        },
        'Request 1'
      );

      expect(errors).toContain(
        'Request 1: action.oldContent is required when using deprecated action.position for replace'
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

    it('routes whole-file replace through contentManager.write with overwrite', async () => {
      const { executor, executeAgentTool } = createExecutor();

      await executor.executeContentAction(
        { type: 'replace', targetPath: 'notes/demo.md' },
        'Entire replacement'
      );

      expect(executeAgentTool).toHaveBeenCalledWith(
        'contentManager',
        'write',
        expect.objectContaining({
          path: 'notes/demo.md',
          content: 'Entire replacement',
          overwrite: true,
        })
      );
    });

    it('routes line-range replace through contentManager.replace', async () => {
      const { executor, executeAgentTool } = createExecutor();

      await executor.executeContentAction(
        {
          type: 'replace',
          targetPath: 'notes/demo.md',
          oldContent: 'Old paragraph',
          startLine: 4,
          endLine: 6,
        },
        'New paragraph',
        'session-2',
        'ctx-2'
      );

      expect(executeAgentTool).toHaveBeenCalledWith(
        'contentManager',
        'replace',
        {
          path: 'notes/demo.md',
          oldContent: 'Old paragraph',
          newContent: 'New paragraph',
          startLine: 4,
          endLine: 6,
          sessionId: 'session-2',
          context: 'ctx-2',
        }
      );
    });

    it('normalizes deprecated position-based replace to a single-line replace call', async () => {
      const { executor, executeAgentTool } = createExecutor();

      await executor.executeContentAction(
        {
          type: 'replace',
          targetPath: 'notes/demo.md',
          oldContent: 'Old line',
          position: 9,
        },
        'New line'
      );

      expect(executeAgentTool).toHaveBeenCalledWith(
        'contentManager',
        'replace',
        expect.objectContaining({
          path: 'notes/demo.md',
          oldContent: 'Old line',
          newContent: 'New line',
          startLine: 9,
          endLine: 9,
        })
      );
    });

    it('fails fast on invalid replace actions before calling agentManager', async () => {
      const { executor, executeAgentTool } = createExecutor();

      const result = await executor.executeContentAction(
        {
          type: 'replace',
          targetPath: 'notes/demo.md',
          startLine: 4,
          endLine: 5,
        },
        'New paragraph'
      );

      expect(result).toEqual({
        success: false,
        error: 'replace line-range mode requires oldContent, startLine, and endLine',
      });
      expect(executeAgentTool).not.toHaveBeenCalled();
    });
  });
});