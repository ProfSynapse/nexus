import { UseToolTool } from '../../src/agents/toolManager/tools/useTools';

describe('useTools operationId contract', () => {
  function createTool() {
    const batch = { execute: jest.fn(async () => ({ success: true })) };
    const normalizer = {
      validateExecutionContext: jest.fn(),
      normalizeContext: jest.fn(() => ({
        workspaceId: 'default', sessionId: 'session', memory: 'memory', goal: 'goal'
      })),
      normalizeExecutionCalls: jest.fn(() => [{
        agent: 'contentManager', tool: 'read', params: { path: 'A.md' }
      }]),
    };
    return { tool: new UseToolTool(batch as never, normalizer as never), batch };
  }

  it('forwards a valid caller identity as a replayable external operation', async () => {
    const { tool, batch } = createTool();
    await tool.execute({
      workspaceId: 'default', sessionId: 'session', memory: 'memory', goal: 'goal',
      tool: 'content read --path A.md', operationId: 'caller.retry-1'
    });

    expect(batch.execute).toHaveBeenCalledWith(expect.any(Object), {
      operationId: 'caller.retry-1',
      operationOrigin: 'external-mcp',
      operationReplayable: true,
    });
  });

  it('rejects invalid identities loudly before parsing or execution', async () => {
    const { tool, batch } = createTool();
    await expect(tool.execute({
      workspaceId: 'default', sessionId: 'session', memory: 'memory', goal: 'goal',
      tool: 'content read --path A.md', operationId: 'bad id with spaces'
    })).rejects.toThrow(/operationId must be 1-128 characters/);
    expect(batch.execute).not.toHaveBeenCalled();
  });

  it('publishes the operationId validation and retry semantics in the live schema', () => {
    const { tool } = createTool();
    const schema = tool.getParameterSchema() as {
      properties: Record<string, { pattern?: string; description?: string }>;
    };
    expect(schema.properties.operationId.pattern).toBe('^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
    expect(schema.properties.operationId.description).toMatch(/exact retry/);
  });
});
