/**
 * ToolManager schema refresh wiring tests.
 *
 * Verifies that mutation events on WorkspaceService and CustomPromptStorageService
 * fire registered change listeners so AgentRegistrationService can rebuild the
 * SchemaData pushed into ToolManagerAgent.refreshSchemaData().
 *
 * Scope: service-level listener firing only. Full end-to-end wiring through
 * AgentRegistrationService requires a live plugin + ServiceManager, which is
 * covered by manual integration testing in the running plugin.
 */

import { App } from 'obsidian';
import { ToolManagerAgent, SchemaData } from '../../src/agents/toolManager/toolManager';
import { WorkspaceService } from '../../src/services/WorkspaceService';
import { CustomPromptStorageService } from '../../src/agents/promptManager/services/CustomPromptStorageService';
import type { IStorageAdapter } from '../../src/database/interfaces/IStorageAdapter';
import type { WorkspaceMetadata as HybridWorkspaceMetadata } from '../../src/types/storage/HybridStorageTypes';
import type { Settings } from '../../src/types';

function makeAdapter(overrides: Partial<IStorageAdapter> = {}): IStorageAdapter {
  return {
    isReady: jest.fn().mockReturnValue(true),
    isQueryReady: jest.fn().mockReturnValue(true),
    createWorkspace: jest.fn().mockResolvedValue('ws-1'),
    updateWorkspace: jest.fn().mockResolvedValue(undefined),
    deleteWorkspace: jest.fn().mockResolvedValue(undefined),
    getWorkspace: jest.fn().mockResolvedValue(null),
    ...overrides
  } as unknown as IStorageAdapter;
}

function makeWorkspaceService(adapter: IStorageAdapter): WorkspaceService {
  return new WorkspaceService(
    { app: new App() } as never,
    {} as never,
    {} as never,
    adapter
  );
}

function makeSettings(): Settings {
  // Minimal Settings-shaped stub: the storage service only reads settings.customPrompts
  // and calls saveSettings() for data.json persistence.
  const store: { settings: { customPrompts?: { enabled: boolean; prompts: unknown[] } } } = {
    settings: { customPrompts: { enabled: true, prompts: [] } }
  };
  return {
    settings: store.settings,
    saveSettings: jest.fn().mockResolvedValue(undefined)
  } as unknown as Settings;
}

describe('WorkspaceService.setOnChange', () => {
  it('fires the listener after createWorkspace', async () => {
    const service = makeWorkspaceService(makeAdapter());
    const listener = jest.fn();
    service.setOnChange(listener);

    await service.createWorkspace({ name: 'New Workspace' });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires the listener after updateWorkspace', async () => {
    const existing: HybridWorkspaceMetadata = {
      id: 'ws-1',
      name: 'Existing',
      rootFolder: '/',
      created: 1,
      lastAccessed: 1,
      isActive: true
    };
    const adapter = makeAdapter({
      getWorkspace: jest.fn().mockResolvedValue(existing)
    });
    const service = makeWorkspaceService(adapter);
    const listener = jest.fn();
    service.setOnChange(listener);

    await service.updateWorkspace('ws-1', { description: 'Updated' });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires the listener after deleteWorkspace', async () => {
    const service = makeWorkspaceService(makeAdapter());
    const listener = jest.fn();
    service.setOnChange(listener);

    await service.deleteWorkspace('ws-1');

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('swallows listener errors so mutations still succeed', async () => {
    const service = makeWorkspaceService(makeAdapter());
    service.setOnChange(() => {
      throw new Error('listener blew up');
    });

    // Should not throw despite the listener's error.
    await expect(service.createWorkspace({ name: 'Safe' })).resolves.toBeDefined();
  });

  it('detaches when set to null', async () => {
    const service = makeWorkspaceService(makeAdapter());
    const listener = jest.fn();
    service.setOnChange(listener);
    service.setOnChange(null);

    await service.createWorkspace({ name: 'Silent' });

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('CustomPromptStorageService.setOnChange', () => {
  it('fires the listener after createPrompt', async () => {
    const storage = new CustomPromptStorageService(null, makeSettings());
    const listener = jest.fn();
    storage.setOnChange(listener);

    await storage.createPrompt({
      name: 'Persona A',
      description: 'desc',
      prompt: 'system prompt body',
      isEnabled: true
    });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires the listener after updatePrompt', async () => {
    const storage = new CustomPromptStorageService(null, makeSettings());
    const created = await storage.createPrompt({
      name: 'Persona B',
      description: '',
      prompt: 'body',
      isEnabled: true
    });
    const listener = jest.fn();
    storage.setOnChange(listener);

    await storage.updatePrompt(created.id, { description: 'new desc' });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires the listener after deletePrompt', async () => {
    const storage = new CustomPromptStorageService(null, makeSettings());
    const created = await storage.createPrompt({
      name: 'Persona C',
      description: '',
      prompt: 'body',
      isEnabled: true
    });
    const listener = jest.fn();
    storage.setOnChange(listener);

    await storage.deletePrompt(created.id);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires the listener after togglePrompt (via updatePrompt)', async () => {
    const storage = new CustomPromptStorageService(null, makeSettings());
    const created = await storage.createPrompt({
      name: 'Persona D',
      description: '',
      prompt: 'body',
      isEnabled: true
    });
    const listener = jest.fn();
    storage.setOnChange(listener);

    await storage.togglePrompt(created.id);

    // togglePrompt delegates to updatePrompt so the listener fires once.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires the listener after setEnabled', async () => {
    const storage = new CustomPromptStorageService(null, makeSettings());
    const listener = jest.fn();
    storage.setOnChange(listener);

    await storage.setEnabled(false);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('swallows listener errors so mutations still succeed', async () => {
    const storage = new CustomPromptStorageService(null, makeSettings());
    storage.setOnChange(() => {
      throw new Error('listener blew up');
    });

    await expect(storage.createPrompt({
      name: 'Safe Persona',
      description: '',
      prompt: 'body',
      isEnabled: true
    })).resolves.toMatchObject({ name: 'Safe Persona' });
  });
});

describe('ToolManagerAgent.refreshSchemaData integration', () => {
  function createToolManager(schemaData: SchemaData): ToolManagerAgent {
    return new ToolManagerAgent(new App(), new Map(), schemaData);
  }

  it('updates the getTools description when refreshSchemaData is called', () => {
    const toolManager = createToolManager({
      workspaces: [],
      customAgents: [],
      vaultRoot: []
    });
    const before = toolManager.getTool('getTools')?.description ?? '';
    expect(before).not.toContain('renamed-ws');

    toolManager.refreshSchemaData({
      workspaces: [{ name: 'renamed-ws' }],
      customAgents: [{ name: 'new-persona' }],
      vaultRoot: ['Inbox', 'Projects']
    });

    const after = toolManager.getTool('getTools')?.description ?? '';
    expect(after).toContain('renamed-ws');
    expect(after).toContain('new-persona');
    expect(after).toContain('Inbox');
  });

  it('simulates a mutation→refresh cycle end-to-end at the data layer', async () => {
    // Mimic the AgentRegistrationService.refreshToolManagerSchema wiring:
    // a listener builds fresh SchemaData and pushes it into ToolManager.
    const toolManager = createToolManager({
      workspaces: [],
      customAgents: [],
      vaultRoot: []
    });

    const workspaces: { name: string; description?: string }[] = [];
    const buildSchema = (): SchemaData => ({
      workspaces: [...workspaces],
      customAgents: [],
      vaultRoot: []
    });

    const workspaceService = makeWorkspaceService(makeAdapter({
      createWorkspace: jest.fn().mockImplementation((data: HybridWorkspaceMetadata) => {
        workspaces.push({ name: data.name });
        return Promise.resolve(data.id ?? 'ws-generated');
      })
    }));
    workspaceService.setOnChange(() => {
      toolManager.refreshSchemaData(buildSchema());
    });

    await workspaceService.createWorkspace({ id: 'ws-alpha', name: 'Alpha Workspace' });

    const description = toolManager.getTool('getTools')?.description ?? '';
    expect(description).toContain('Alpha Workspace');
  });
});
