/** @jest-environment node */

import { ToolOperationService } from '../../src/agents/toolManager/services/ToolOperationService';

describe('ToolOperationService headless construction', () => {
  it('constructs without a browser window when persistence is intentionally absent', async () => {
    const service = new ToolOperationService();
    await expect(service.execute({
      operationId: 'headless:0',
      origin: 'external-mcp',
      replayable: false,
      workspaceId: 'default',
      sessionId: 'headless',
      agent: 'contentManager',
      tool: 'read',
      params: {},
      replayPolicy: 'safe',
    }, async () => ({
      agent: 'contentManager', tool: 'read', success: true, data: { content: 'ok' },
    }))).resolves.toEqual(expect.objectContaining({ success: true }));
  });
});
