/**
 * Regression tests: the memoryManager workspace tools confine the caller-supplied
 * `rootFolder` to the vault. An escaping rootFolder must be rejected WITHOUT a
 * vault createFolder or a workspace persist.
 * See docs/plans/vault-path-confinement-plan.md.
 */

const mockCreateWorkspace = jest.fn().mockResolvedValue({ id: 'ws-1', name: 'ws' });
const mockUpdateWorkspace = jest.fn().mockResolvedValue(undefined);
const mockGetByNameOrId = jest.fn();

jest.mock('@/agents/memoryManager/services/ValidationService', () => ({
  createServiceIntegration: () => ({
    getWorkspaceService: async () => ({
      success: true,
      service: {
        getWorkspaceByNameOrId: mockGetByNameOrId,
        createWorkspace: mockCreateWorkspace,
        updateWorkspace: mockUpdateWorkspace,
      },
    }),
  }),
}));

import { CreateWorkspaceTool } from '@/agents/memoryManager/tools/workspaces/createWorkspace';
import { UpdateWorkspaceTool } from '@/agents/memoryManager/tools/workspaces/updateWorkspace';

// A POSIX leading slash (/tmp/ESCAPE) is stripped to vault-relative (backward-compat), not an escape.
const ESCAPING = ['../../../../tmp/ESCAPE', '~/ESCAPE'];

function makeAgent(): { agent: any; createFolder: jest.Mock } {
  const createFolder = jest.fn().mockResolvedValue(undefined);
  const app = { vault: { getAbstractFileByPath: jest.fn().mockReturnValue(null), createFolder } };
  return { agent: { getApp: () => app }, createFolder };
}

beforeEach(() => {
  mockCreateWorkspace.mockClear();
  mockUpdateWorkspace.mockClear();
  mockGetByNameOrId.mockReset();
});

describe('CreateWorkspaceTool rootFolder confinement', () => {
  it.each(ESCAPING)('rejects escaping rootFolder %s with no createFolder/persist', async (rootFolder) => {
    mockGetByNameOrId.mockResolvedValue(null);
    const { agent, createFolder } = makeAgent();
    const result = await new CreateWorkspaceTool(agent).execute({
      name: 'ws', description: 'd', purpose: 'p', rootFolder,
    } as any);
    expect(result.success).toBe(false);
    expect(createFolder).not.toHaveBeenCalled();
    expect(mockCreateWorkspace).not.toHaveBeenCalled();
  });

  it('creates a workspace with a normal rootFolder', async () => {
    mockGetByNameOrId.mockResolvedValue(null);
    const { agent } = makeAgent();
    const result = await new CreateWorkspaceTool(agent).execute({
      name: 'ws', description: 'd', purpose: 'p', rootFolder: 'projects/ws',
    } as any);
    expect(result.success).toBe(true);
    expect(mockCreateWorkspace).toHaveBeenCalledWith(expect.objectContaining({ rootFolder: 'projects/ws' }));
  });

  it('accepts the "/" root sentinel (vault root) without rejecting it as absolute', async () => {
    mockGetByNameOrId.mockResolvedValue(null);
    const { agent } = makeAgent();
    const result = await new CreateWorkspaceTool(agent).execute({
      name: 'ws', description: 'd', purpose: 'p', rootFolder: '/',
    } as any);
    expect(result.success).toBe(true);
    expect(mockCreateWorkspace).toHaveBeenCalledWith(expect.objectContaining({ rootFolder: '/' }));
  });
});

describe('UpdateWorkspaceTool rootFolder confinement', () => {
  it.each(ESCAPING)('rejects escaping rootFolder %s with no createFolder/persist', async (rootFolder) => {
    mockGetByNameOrId.mockResolvedValue({ id: 'ws-1', name: 'ws', context: {} });
    const { agent, createFolder } = makeAgent();
    const result = await new UpdateWorkspaceTool(agent).execute({ id: 'ws', rootFolder } as any);
    expect(result.success).toBe(false);
    expect(createFolder).not.toHaveBeenCalled();
    expect(mockUpdateWorkspace).not.toHaveBeenCalled();
  });

  it('updates a workspace with a normal rootFolder', async () => {
    mockGetByNameOrId.mockResolvedValue({ id: 'ws-1', name: 'ws', context: {} });
    const { agent } = makeAgent();
    const result = await new UpdateWorkspaceTool(agent).execute({ id: 'ws', rootFolder: 'projects/ws' } as any);
    expect(result.success).toBe(true);
    expect(mockUpdateWorkspace).toHaveBeenCalledWith('ws-1', expect.objectContaining({ rootFolder: 'projects/ws' }));
  });
});
