/**
 * ConfirmModal Call-Site Integration Tests
 *
 * Asserts that the 3 in-scope PR1 call sites invoke `ConfirmModal.confirm(app, config)`
 * (Group A M-2 static helper) with the right variant/title/body shape, and that
 * the surrounding `await confirm...` promise resolves correctly based on the
 * user's choice.
 *
 * Strategy: jest.mock the ConfirmModal module so its `confirm()` static is a
 * jest.fn that captures (app, config) per call and returns a manually-resolvable
 * Promise. Tests then drive resolution via `resolveLast(true|false)`.
 *
 * Coverage:
 *   - WorkspacesTab.confirmDeleteWorkspace (variant=delete)
 *   - WorkspaceDetailRenderer.confirmDangerousAction (variant=delete, uniform per CODE decision)
 *   - StatesSectionRenderer.confirmArchive (variant=archive, reversible accent)
 */

import { App, Component, createMockElement } from 'obsidian';

interface CapturedConfirmCall {
  app: unknown;
  config: {
    variant: 'delete' | 'remove' | 'archive';
    title: string;
    body: string;
    ctaLabel?: string;
    onConfirm?: () => void | Promise<void>;
  };
  resolve: (value: boolean) => void;
}

const capturedInstances: CapturedConfirmCall[] = [];

jest.mock('../../src/settings/components/ConfirmModal', () => {
  return {
    ConfirmModal: {
      confirm: jest.fn().mockImplementation((app: unknown, config: CapturedConfirmCall['config']) => {
        return new Promise<boolean>((resolve) => {
          capturedInstances.push({ app, config, resolve });
        });
      })
    }
  };
});

// Imports MUST come after jest.mock for hoisting to take effect.
import { WorkspacesTab } from '../../src/settings/tabs/WorkspacesTab';
import { WorkspaceDetailRenderer } from '../../src/components/workspace/WorkspaceDetailRenderer';
import { StatesSectionRenderer, StatesSectionService } from '../../src/components/workspace/StatesSectionRenderer';
import { SettingsRouter } from '../../src/settings/SettingsRouter';

/**
 * Test-only surface for invoking the private confirm helpers without dragging
 * in the full renderer machinery. Mirrors the established pattern in
 * tests/unit/WorkspacesTab.test.ts.
 */
interface TestableWorkspacesTab {
  currentWorkspace: { id: string; name: string } | null;
  confirmDeleteWorkspace(workspaceName?: string): Promise<boolean>;
}

interface TestableDetailRenderer {
  confirmDangerousAction(app: App, message: string): Promise<boolean>;
}

interface TestableStatesRenderer {
  confirmArchive(stateName: string): Promise<boolean>;
}

function makeStatesService(): jest.Mocked<StatesSectionService> {
  return {
    listStates: jest.fn().mockResolvedValue([]),
    updateState: jest.fn().mockResolvedValue(undefined),
    archiveState: jest.fn().mockResolvedValue(undefined),
    deleteState: jest.fn().mockResolvedValue(undefined)
  } as unknown as jest.Mocked<StatesSectionService>;
}

/** Drive the spy through a successful CTA-click cycle (resolves true). */
function clickCta(instance: CapturedConfirmCall): void {
  instance.resolve(true);
}

/** Drive the spy through a Cancel-click cycle (resolves false). */
function clickCancel(instance: CapturedConfirmCall): void {
  instance.resolve(false);
}

describe('ConfirmModal call-site integration', () => {
  beforeEach(() => {
    capturedInstances.length = 0;
  });

  describe('WorkspacesTab.confirmDeleteWorkspace (variant=delete)', () => {
    function createTab(): TestableWorkspacesTab {
      const container = createMockElement('div');
      const router = new SettingsRouter();
      const tab = new WorkspacesTab(container, router, {
        app: new App(),
        component: new Component(),
        prefetchedWorkspaces: [],
        workspaceService: undefined
      });
      return tab as unknown as TestableWorkspacesTab;
    }

    it('constructs ConfirmModal with variant=delete + workspace-named copy', async () => {
      const tab = createTab();
      tab.currentWorkspace = { id: 'ws-1', name: 'Acme Q2 launch' };

      const pending = tab.confirmDeleteWorkspace();
      // Give the microtask queue a tick so the modal is constructed + opened.
      await Promise.resolve();

      expect(capturedInstances).toHaveLength(1);
      const inst = capturedInstances[0];
      expect(inst.config.variant).toBe('delete');
      expect(inst.config.title).toBe('Delete workspace?');
      expect(inst.config.body).toBe('Delete workspace "Acme Q2 launch"? This cannot be undone.');

      // Resolve the dangling promise so the test cleanup doesn't leak.
      clickCancel(inst);
      await expect(pending).resolves.toBe(false);
    });

    it('honors explicit workspaceName arg over currentWorkspace.name', async () => {
      const tab = createTab();
      tab.currentWorkspace = { id: 'ws-1', name: 'Other' };

      const pending = tab.confirmDeleteWorkspace('Override name');
      await Promise.resolve();

      expect(capturedInstances).toHaveLength(1);
      expect(capturedInstances[0].config.body).toContain('"Override name"');

      clickCancel(capturedInstances[0]);
      await pending;
    });

    it('falls back to "Workspace" when no name available', async () => {
      const tab = createTab();
      tab.currentWorkspace = null;

      const pending = tab.confirmDeleteWorkspace();
      await Promise.resolve();

      expect(capturedInstances).toHaveLength(1);
      expect(capturedInstances[0].config.body).toContain('"Workspace"');

      clickCancel(capturedInstances[0]);
      await pending;
    });

    it('resolves true when user confirms (CTA click → onConfirm → onClose)', async () => {
      const tab = createTab();
      tab.currentWorkspace = { id: 'ws-1', name: 'Demo' };

      const pending = tab.confirmDeleteWorkspace();
      await Promise.resolve();

      clickCta(capturedInstances[0]);
      await expect(pending).resolves.toBe(true);
    });

    it('resolves false when user cancels (onClose without onConfirm)', async () => {
      const tab = createTab();
      tab.currentWorkspace = { id: 'ws-1', name: 'Demo' };

      const pending = tab.confirmDeleteWorkspace();
      await Promise.resolve();

      clickCancel(capturedInstances[0]);
      await expect(pending).resolves.toBe(false);
    });
  });

  describe('WorkspaceDetailRenderer.confirmDangerousAction (variant=delete uniform)', () => {
    /**
     * Frontend-coder's CODE decision: confirmDangerousAction always uses
     * variant=delete (uniform), regardless of the calling action (project
     * delete vs task delete). Both invoke this single helper; per-call-site
     * variant semantics are deferred to PR2/PR3.
     */
    function createRenderer(): TestableDetailRenderer {
      const renderer = new WorkspaceDetailRenderer(new Component());
      return renderer as unknown as TestableDetailRenderer;
    }

    it('constructs ConfirmModal with variant=delete + caller-supplied message', async () => {
      const renderer = createRenderer();
      const app = new App();

      const pending = renderer.confirmDangerousAction(
        app,
        'Delete this project and all its tasks? This cannot be undone.'
      );
      await Promise.resolve();

      expect(capturedInstances).toHaveLength(1);
      const inst = capturedInstances[0];
      expect(inst.config.variant).toBe('delete');
      expect(inst.config.title).toBe('Confirm delete');
      expect(inst.config.body).toBe('Delete this project and all its tasks? This cannot be undone.');
      expect(inst.app).toBe(app);

      clickCancel(inst);
      await pending;
    });

    it('uses the same variant=delete for the task-deletion message', async () => {
      const renderer = createRenderer();
      const app = new App();

      const pending = renderer.confirmDangerousAction(
        app,
        'Delete this task? This cannot be undone.'
      );
      await Promise.resolve();

      // CODE decision documented in commit body: "variant=delete uniform"
      expect(capturedInstances[0].config.variant).toBe('delete');
      expect(capturedInstances[0].config.body).toBe('Delete this task? This cannot be undone.');

      clickCancel(capturedInstances[0]);
      await pending;
    });

    it('resolves true on confirm and false on cancel', async () => {
      const renderer = createRenderer();
      const app = new App();

      const confirmPending = renderer.confirmDangerousAction(app, 'msg-1');
      await Promise.resolve();
      clickCta(capturedInstances[0]);
      await expect(confirmPending).resolves.toBe(true);

      capturedInstances.length = 0;

      const cancelPending = renderer.confirmDangerousAction(app, 'msg-2');
      await Promise.resolve();
      clickCancel(capturedInstances[0]);
      await expect(cancelPending).resolves.toBe(false);
    });
  });

  describe('StatesSectionRenderer.confirmArchive (variant=archive)', () => {
    function createRenderer(): {
      renderer: TestableStatesRenderer;
      service: jest.Mocked<StatesSectionService>;
    } {
      const service = makeStatesService();
      const renderer = new StatesSectionRenderer(new App(), service, new Component());
      return { renderer: renderer as unknown as TestableStatesRenderer, service };
    }

    it('constructs ConfirmModal with variant=archive + reversible-action copy', async () => {
      const { renderer } = createRenderer();

      const pending = renderer.confirmArchive('Pre-launch snapshot');
      await Promise.resolve();

      expect(capturedInstances).toHaveLength(1);
      const inst = capturedInstances[0];
      expect(inst.config.variant).toBe('archive');
      expect(inst.config.title).toBe('Archive state?');
      // Copy must communicate reversibility — flagged by mockup as the
      // distinguishing trait of archive vs delete.
      expect(inst.config.body).toContain('Pre-launch snapshot');
      expect(inst.config.body).toContain('You can restore it later');

      clickCancel(inst);
      await pending;
    });

    it('resolves true on confirm (archive flow proceeds)', async () => {
      const { renderer } = createRenderer();

      const pending = renderer.confirmArchive('S1');
      await Promise.resolve();
      clickCta(capturedInstances[0]);

      await expect(pending).resolves.toBe(true);
    });

    it('resolves false on cancel (archive flow aborts)', async () => {
      const { renderer } = createRenderer();

      const pending = renderer.confirmArchive('S1');
      await Promise.resolve();
      clickCancel(capturedInstances[0]);

      await expect(pending).resolves.toBe(false);
    });
  });

  describe('Cross-site invariants', () => {
    it('PR1 wires NO ConfirmModal call site to variant=remove (deferred to PR2)', async () => {
      // Triple-touch every PR1 call site; assert none of them use 'remove'.
      // PR2 will introduce 'remove' for key-files row removal (out of PR1 scope).
      const tab = new WorkspacesTab(createMockElement('div'), new SettingsRouter(), {
        app: new App(),
        component: new Component(),
        prefetchedWorkspaces: [],
        workspaceService: undefined
      }) as unknown as TestableWorkspacesTab;
      tab.currentWorkspace = { id: 'ws-1', name: 'X' };
      const p1 = tab.confirmDeleteWorkspace();
      await Promise.resolve();
      clickCancel(capturedInstances[0]);
      await p1;

      const detail = new WorkspaceDetailRenderer(new Component()) as unknown as TestableDetailRenderer;
      const p2 = detail.confirmDangerousAction(new App(), 'x');
      await Promise.resolve();
      clickCancel(capturedInstances[1]);
      await p2;

      const service = makeStatesService();
      const states = new StatesSectionRenderer(new App(), service, new Component()) as unknown as TestableStatesRenderer;
      const p3 = states.confirmArchive('s');
      await Promise.resolve();
      clickCancel(capturedInstances[2]);
      await p3;

      const variants = capturedInstances.map((i) => i.config.variant);
      expect(variants).toEqual(['delete', 'delete', 'archive']);
      expect(variants).not.toContain('remove');
    });
  });
});
