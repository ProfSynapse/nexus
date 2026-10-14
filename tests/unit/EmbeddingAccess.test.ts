/**
 * `resolveEmbeddingService` is the only way to reach the live EmbeddingService.
 *
 * Five call sites used to ask the service registry for `'embeddingService'`, a
 * name nothing registers, so every one of them silently got null. The
 * accessor reads `plugin.embeddingManager` instead and answers only while the
 * manager is enabled and initialized. These cases pin that contract, plus the
 * two view call sites (task board and the Workspaces tab's task detail) that
 * hand the service to the note-link suggester.
 */

import { App, WorkspaceLeaf } from 'obsidian';
import { resolveEmbeddingService } from '../../src/services/embeddings/embeddingAccess';
import { ProjectsManagerView, type ProjectsManagerCallbacks } from '../../src/components/workspace/ProjectsManagerView';
import { WorkspaceDetailRenderer } from '../../src/components/workspace/WorkspaceDetailRenderer';
import { TaskBoardView } from '../../src/ui/tasks/TaskBoardView';
import { PLUGIN_IDS } from '../../src/constants/branding';

const SERVICE = { label: 'live service' };

function manager(enabled: boolean, service: unknown = SERVICE) {
  return {
    isEmbeddingEnabled: () => enabled,
    getService: () => service
  };
}

describe('resolveEmbeddingService', () => {
  it('returns the manager service while the manager is enabled and initialized', () => {
    expect(resolveEmbeddingService({ embeddingManager: manager(true) })).toBe(SERVICE);
  });

  it('returns null while embeddings are turned off or not yet initialized', () => {
    expect(resolveEmbeddingService({ embeddingManager: manager(false) })).toBeNull();
  });

  it('returns null when the manager has no service', () => {
    expect(resolveEmbeddingService({ embeddingManager: manager(true, null) })).toBeNull();
  });

  it('returns null without a manager (mobile, or before storage is ready)', () => {
    expect(resolveEmbeddingService({})).toBeNull();
    expect(resolveEmbeddingService(null)).toBeNull();
    expect(resolveEmbeddingService(undefined)).toBeNull();
  });

  it('ignores a registry that would answer for embeddingService', () => {
    const getServiceIfReady = jest.fn(() => ({ label: 'registry' }));
    expect(resolveEmbeddingService({ getServiceIfReady })).toBeNull();
    expect(getServiceIfReady).not.toHaveBeenCalled();
  });

  it('returns null instead of throwing when the manager throws', () => {
    const broken = {
      isEmbeddingEnabled: () => { throw new Error('torn down'); },
      getService: () => SERVICE
    };
    expect(resolveEmbeddingService({ embeddingManager: broken })).toBeNull();
  });
});

describe('view call sites resolve through the plugin embedding manager', () => {
  function pluginWith(embeddingManager: unknown) {
    const plugin: Record<string, unknown> = {
      embeddingManager,
      getServiceIfReady: jest.fn(() => null),
      getService: jest.fn(async () => null)
    };
    const app = {
      plugins: { getPlugin: (id: string) => (id === PLUGIN_IDS.current ? plugin : null) },
      workspace: { on: jest.fn(), offref: jest.fn() },
      vault: { on: jest.fn(), offref: jest.fn() }
    };
    plugin.app = app;
    return { plugin, app: app as unknown as App };
  }

  it('Workspaces tab task detail hands the note suggester the live service', () => {
    const mgr = { enabled: true, isEmbeddingEnabled() { return this.enabled; }, getService: () => SERVICE };
    const { plugin, app } = pluginWith(mgr);
    const callbacks = { getApp: () => app } as unknown as ProjectsManagerCallbacks;
    const view = new ProjectsManagerView({} as WorkspaceDetailRenderer, undefined, callbacks);

    const taskCallbacks = (view as unknown as {
      buildTaskDetailCallbacks(): { getEmbeddingService?: () => unknown };
    }).buildTaskDetailCallbacks();

    expect(taskCallbacks.getEmbeddingService?.()).toBe(SERVICE);
    mgr.enabled = false;
    expect(taskCallbacks.getEmbeddingService?.()).toBeNull();
    expect(plugin.getServiceIfReady).not.toHaveBeenCalledWith('embeddingService');
  });

  it('task board edit modal gets the live service', () => {
    const { plugin, app } = pluginWith(manager(true));
    const leaf = { app } as unknown as WorkspaceLeaf;
    const view = new TaskBoardView(leaf, plugin as never);

    const deps = (view as unknown as {
      editCoordinator: { deps: { getEmbeddingService: () => unknown } };
    }).editCoordinator.deps;

    expect(deps.getEmbeddingService()).toBe(SERVICE);
    expect(plugin.getServiceIfReady).not.toHaveBeenCalledWith('embeddingService');
  });
});
