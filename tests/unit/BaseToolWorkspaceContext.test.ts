import { BaseTool } from '../../src/agents/baseTool';
import { CommonParameters, CommonResult } from '../../src/types';
import { JSONSchema } from '../../src/types/schema/JSONSchemaTypes';

class WorkspaceContextTestTool extends BaseTool<CommonParameters, CommonResult> {
  constructor() {
    super('workspaceContextTest', 'Workspace context test', 'Tests workspace context resolution', '1.0.0');
  }

  async execute(_params: CommonParameters): Promise<CommonResult> {
    return { success: true };
  }

  getParameterSchema(): JSONSchema {
    return { type: 'object' };
  }

  resolve(params: CommonParameters): CommonResult['workspaceContext'] | null {
    return this.getInheritedWorkspaceContext(params);
  }
}

function buildParams(workspaceId: string): CommonParameters {
  return {
    context: {
      workspaceId,
      sessionId: 'session-1',
      memory: 'Testing workspace context resolution.',
      goal: 'Ensure canonical tool context scopes state tools.'
    }
  };
}

describe('BaseTool workspace context resolution', () => {
  it('uses the canonical tool context workspaceId when workspaceContext is absent', () => {
    const tool = new WorkspaceContextTestTool();

    expect(tool.resolve(buildParams('workspace-uuid'))).toEqual({
      workspaceId: 'workspace-uuid',
      workspacePath: [],
      activeWorkspace: true
    });
  });

  it('uses a direct workspaceId param injected by tool batch execution', () => {
    const tool = new WorkspaceContextTestTool();
    const params: CommonParameters & { workspaceId: string } = {
      ...buildParams('context-workspace'),
      workspaceId: 'direct-workspace'
    };

    expect(tool.resolve(params)?.workspaceId).toBe('direct-workspace');
  });
});
