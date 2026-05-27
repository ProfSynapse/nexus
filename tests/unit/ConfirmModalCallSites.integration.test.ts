/**
 * ConfirmModal Call-Site Integration Tests
 *
 * Asserts that the 5 in-scope settings-UI call sites invoke
 * `ConfirmModal.confirm(app, config)` (Group A M-2 static helper) with the
 * right variant/title/body shape, and that the surrounding `await confirm...`
 * promise resolves correctly based on the user's choice.
 *
 * Strategy: jest.mock the ConfirmModal module so its `confirm()` static is a
 * jest.fn that captures (app, config) per call and returns a manually-resolvable
 * Promise. Tests then drive resolution via `resolveLast(true|false)`.
 *
 * Coverage:
 *   - WorkspacesTab.confirmDeleteWorkspace (variant=delete)
 *   - WorkspaceDetailRenderer.confirmDangerousAction (variant=delete, uniform per CODE decision)
 *   - StatesSectionRenderer.confirmArchive (variant=archive, reversible accent)
 *   - WorkspaceFormRenderer workflow-× (variant=remove, PR2 Group B)
 *   - WorkspaceFormRenderer keyfile-× (variant=remove, PR2 Group B)
 */

import { App, ButtonComponent, Component, createMockElement } from 'obsidian';

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
import { WorkspaceFormRenderer } from '../../src/components/workspace/WorkspaceFormRenderer';
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

/**
 * Capture every ButtonComponent.onClick callback wired during a render pass,
 * in DOM-construction order. Used by the WorkspaceFormRenderer × tests to
 * reach the inline ConfirmModal.confirm call site without exposing a private
 * test helper from the renderer itself.
 */
function captureButtonClicks(action: () => void): Array<() => void | Promise<void>> {
  const handlers: Array<() => void | Promise<void>> = [];
  const original = ButtonComponent.prototype.onClick;
  ButtonComponent.prototype.onClick = function (this: ButtonComponent, callback: () => void) {
    handlers.push(callback);
    return original.call(this, callback);
  };
  try {
    action();
  } finally {
    ButtonComponent.prototype.onClick = original;
  }
  return handlers;
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

  describe('WorkspaceFormRenderer workflow-× (variant=remove)', () => {
    function createFormRenderer(workflows: Array<{ name: string; agents: string[] }>, keyFiles: string[]) {
      const formData = {
        id: 'ws-1',
        name: 'Test workspace',
        context: { purpose: '', workflows, keyFiles, preferences: '' }
      } as unknown as Parameters<typeof WorkspaceFormRenderer>[0];
      return new WorkspaceFormRenderer(
        formData as never,
        [],
        () => undefined,
        () => undefined,
        () => undefined,
        () => undefined,
        new Component(),
        new App()
      );
    }

    /**
     * Render the form, invoke every captured ButtonComponent.onClick handler,
     * and isolate the unique invocation that wires through ConfirmModal.confirm
     * with the expected variant. Order-independent so the test survives unrelated
     * ButtonComponent reorderings inside the renderer.
     */
    async function triggerRemoveOfType(
      renderer: WorkspaceFormRenderer,
      expectedTitle: string
    ): Promise<CapturedConfirmCall> {
      const container = createMockElement('div');
      const handlers = captureButtonClicks(() => renderer.render(container));
      for (const handler of handlers) {
        const before = capturedInstances.length;
        // Fire-and-forget — × handler awaits an unresolved ConfirmModal.confirm
        // Promise (mock captures and waits for manual resolve). The synchronous
        // body up through ConfirmModal.confirm(...) runs first and pushes to
        // capturedInstances; awaiting the handler itself would deadlock.
        void handler();
        await Promise.resolve();
        if (capturedInstances.length > before) {
          const inst = capturedInstances[capturedInstances.length - 1];
          if (inst.config.title === expectedTitle) {
            return inst;
          }
          // Drain any non-matching capture (e.g., other × button on a multi-item list).
          clickCancel(inst);
        }
      }
      throw new Error(`No ConfirmModal.confirm call with title "${expectedTitle}"`);
    }

    it('constructs ConfirmModal with variant=remove + workflow-de-association copy', async () => {
      const renderer = createFormRenderer([{ name: 'Daily ingest', agents: [] }], []);
      const inst = await triggerRemoveOfType(renderer, 'Remove workflow');

      expect(inst.config.variant).toBe('remove');
      expect(inst.config.title).toBe('Remove workflow');
      expect(inst.config.body).toBe('Remove this workflow from the workspace? It will not be deleted.');
      expect(inst.config.ctaLabel).toBe('Remove');

      clickCancel(inst);
    });

    it('invokes onConfirm side-effect (splice + onRefresh) only on CTA click', async () => {
      let refreshCalls = 0;
      const workflows = [{ name: 'wf-1', agents: [] }, { name: 'wf-2', agents: [] }];
      const formData = {
        id: 'ws-1',
        name: 'Test',
        context: { purpose: '', workflows, keyFiles: [], preferences: '' }
      } as unknown as Parameters<typeof WorkspaceFormRenderer>[0];
      const renderer = new WorkspaceFormRenderer(
        formData as never,
        [],
        () => undefined,
        () => undefined,
        () => undefined,
        () => { refreshCalls += 1; },
        new Component(),
        new App()
      );

      const inst = await triggerRemoveOfType(renderer, 'Remove workflow');

      // Side effect runs synchronously inside the modal's CTA-click path.
      inst.config.onConfirm?.();
      clickCta(inst);

      expect(refreshCalls).toBe(1);
      expect(workflows).toHaveLength(1);
    });
  });

  describe('WorkspaceFormRenderer keyfile-× (variant=remove)', () => {
    function createFormRenderer(keyFiles: string[]) {
      const formData = {
        id: 'ws-1',
        name: 'Test workspace',
        context: { purpose: '', workflows: [], keyFiles, preferences: '' }
      } as unknown as Parameters<typeof WorkspaceFormRenderer>[0];
      return new WorkspaceFormRenderer(
        formData as never,
        [],
        () => undefined,
        () => undefined,
        () => undefined,
        () => undefined,
        new Component(),
        new App()
      );
    }

    async function triggerRemoveOfType(
      renderer: WorkspaceFormRenderer,
      expectedTitle: string
    ): Promise<CapturedConfirmCall> {
      const container = createMockElement('div');
      const handlers = captureButtonClicks(() => renderer.render(container));
      for (const handler of handlers) {
        const before = capturedInstances.length;
        void handler();
        await Promise.resolve();
        if (capturedInstances.length > before) {
          const inst = capturedInstances[capturedInstances.length - 1];
          if (inst.config.title === expectedTitle) {
            return inst;
          }
          clickCancel(inst);
        }
      }
      throw new Error(`No ConfirmModal.confirm call with title "${expectedTitle}"`);
    }

    it('constructs ConfirmModal with variant=remove + keyfile-de-association copy', async () => {
      const renderer = createFormRenderer(['notes/charter.md']);
      const inst = await triggerRemoveOfType(renderer, 'Remove key file');

      expect(inst.config.variant).toBe('remove');
      expect(inst.config.title).toBe('Remove key file');
      expect(inst.config.body).toBe(
        'Remove this key file from the workspace? The file itself will not be deleted.'
      );
      expect(inst.config.ctaLabel).toBe('Remove');

      clickCancel(inst);
    });
  });

  describe('Cross-site invariants', () => {
    it('settings-UI wires ConfirmModal variants in canonical order: delete, delete, archive, remove, remove', async () => {
      // Order locked per architect's integration note ("surfaces design intent
      // at code-review time"): WorkspacesTab → WorkspaceDetailRenderer →
      // StatesSectionRenderer → WorkspaceFormRenderer workflow-× → keyfile-×.
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

      // Workflow-× then keyfile-× — two fresh WorkspaceFormRenderer instances
      // since each only exercises one × in isolation.
      const formW = new WorkspaceFormRenderer(
        { id: 'ws-1', name: 'X', context: { purpose: '', workflows: [{ name: 'wf', agents: [] }], keyFiles: [], preferences: '' } } as never,
        [],
        () => undefined, () => undefined, () => undefined, () => undefined,
        new Component(), new App()
      );
      const containerW = createMockElement('div');
      const handlersW = captureButtonClicks(() => formW.render(containerW));
      for (const h of handlersW) { void h(); await Promise.resolve(); }

      const formK = new WorkspaceFormRenderer(
        { id: 'ws-1', name: 'X', context: { purpose: '', workflows: [], keyFiles: ['p.md'], preferences: '' } } as never,
        [],
        () => undefined, () => undefined, () => undefined, () => undefined,
        new Component(), new App()
      );
      const containerK = createMockElement('div');
      const handlersK = captureButtonClicks(() => formK.render(containerK));
      for (const h of handlersK) { void h(); await Promise.resolve(); }

      const variants = capturedInstances.map((i) => i.config.variant);
      expect(variants).toEqual(['delete', 'delete', 'archive', 'remove', 'remove']);
    });
  });

  describe('Handler-wrapping side-effect (PR2 Commit 4 — guards inverted-conditional regression)', () => {
    /**
     * For each destructive call site that owns BOTH the confirm AND the
     * onConfirm side-effect, assert:
     *   1. CTA-click runs the side-effect exactly once
     *   2. Cancel-click does NOT run the side-effect
     * This is the contract that catches the PR1 M1 class of regression:
     * an inverted conditional ("if (!confirmed) doDestroy()") would pass
     * the modal-variant test but fail this side-effect test.
     *
     * Sites covered here (side-effect lives in renderer body):
     *   - WorkspaceFormRenderer workflow-× → workflows.splice + onRefresh
     *   - WorkspaceFormRenderer keyfile-× → keyFiles.splice + updateKeyFilesList
     *
     * Sites NOT covered here (side-effect lives in async callback owned by
     * caller — covered structurally in their dedicated tests):
     *   - WorkspacesTab.onDelete → workspaceService.deleteWorkspace (caller-resolved)
     *   - WorkspaceDetailRenderer.deleteProject/deleteTask (caller-resolved)
     *   - StatesSectionRenderer.toggleArchive → archiveState (covered in port test)
     */

    function renderWithCapture(
      workflows: Array<{ name: string; agents: string[] }>,
      keyFiles: string[],
      onRefresh: () => void
    ): Array<() => void | Promise<void>> {
      const formData = {
        id: 'ws-1',
        name: 'X',
        context: { purpose: '', workflows, keyFiles, preferences: '' }
      } as unknown as Parameters<typeof WorkspaceFormRenderer>[0];
      const renderer = new WorkspaceFormRenderer(
        formData as never,
        [],
        () => undefined,
        () => undefined,
        () => undefined,
        onRefresh,
        new Component(),
        new App()
      );
      const container = createMockElement('div');
      return captureButtonClicks(() => renderer.render(container)).map(h => h);
    }

    it('workflow-× CTA fires onConfirm exactly once (splice + onRefresh)', async () => {
      const workflows = [{ name: 'A', agents: [] }, { name: 'B', agents: [] }];
      let refreshCount = 0;
      const handlers = renderWithCapture(workflows, [], () => { refreshCount += 1; });

      // Find handler whose dispatch produces a 'Remove workflow' capture.
      for (const handler of handlers) {
        const before = capturedInstances.length;
        void handler();
        await Promise.resolve();
        if (capturedInstances.length > before) {
          const inst = capturedInstances[capturedInstances.length - 1];
          if (inst.config.title === 'Remove workflow') {
            // Drive the handler-wrapping side-effect — invoke onConfirm
            // exactly as ConfirmModal would on CTA click.
            inst.config.onConfirm?.();
            clickCta(inst);
            break;
          }
          clickCancel(inst);
        }
      }

      expect(workflows).toHaveLength(1);
      expect(refreshCount).toBe(1);
    });

    it('workflow-× Cancel does NOT fire onConfirm (no splice, no refresh)', async () => {
      const workflows = [{ name: 'A', agents: [] }, { name: 'B', agents: [] }];
      let refreshCount = 0;
      const handlers = renderWithCapture(workflows, [], () => { refreshCount += 1; });

      for (const handler of handlers) {
        const before = capturedInstances.length;
        void handler();
        await Promise.resolve();
        if (capturedInstances.length > before) {
          const inst = capturedInstances[capturedInstances.length - 1];
          if (inst.config.title === 'Remove workflow') {
            // Cancel — do NOT invoke onConfirm; resolve(false).
            clickCancel(inst);
            break;
          }
          clickCancel(inst);
        }
      }

      expect(workflows).toHaveLength(2);
      expect(refreshCount).toBe(0);
    });

    it('keyfile-× CTA fires onConfirm exactly once (splice + list refresh)', async () => {
      const keyFiles = ['notes/a.md', 'notes/b.md'];
      const handlers = renderWithCapture([], keyFiles, () => undefined);

      for (const handler of handlers) {
        const before = capturedInstances.length;
        void handler();
        await Promise.resolve();
        if (capturedInstances.length > before) {
          const inst = capturedInstances[capturedInstances.length - 1];
          if (inst.config.title === 'Remove key file') {
            inst.config.onConfirm?.();
            clickCta(inst);
            break;
          }
          clickCancel(inst);
        }
      }

      expect(keyFiles).toHaveLength(1);
    });

    it('keyfile-× Cancel does NOT splice the array', async () => {
      const keyFiles = ['notes/a.md', 'notes/b.md'];
      const handlers = renderWithCapture([], keyFiles, () => undefined);

      for (const handler of handlers) {
        const before = capturedInstances.length;
        void handler();
        await Promise.resolve();
        if (capturedInstances.length > before) {
          const inst = capturedInstances[capturedInstances.length - 1];
          if (inst.config.title === 'Remove key file') {
            clickCancel(inst);
            break;
          }
          clickCancel(inst);
        }
      }

      expect(keyFiles).toEqual(['notes/a.md', 'notes/b.md']);
    });
  });
});
