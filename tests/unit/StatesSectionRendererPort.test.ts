/**
 * StatesSectionRenderer Port Regression Tests
 *
 * Asserts that the PR1 BoxedSection shell port preserved the load-bearing
 * service-call shape from PR #216 / v5.9.7:
 *   - listStates(workspaceId, includeArchived) is called with both branches
 *     of the Show archived toggle.
 *   - Archive callback flow: ConfirmModal accept → archiveState(workspaceId,
 *     sessionId, stateId, restore=false) → list refresh.
 *   - Restore flow skips the confirm modal entirely (one-click reversal).
 *
 * The v5.9.7 archive-visibility fix lives in MemoryService.getStates (covered
 * by tests/unit/MemoryServiceGetStates.test.ts). This file covers the
 * renderer-side contract: that the renderer continues to delegate to the
 * StatesSectionService unchanged, so the v5.9.7 fix surfaces through the UI.
 */

import { App, Component, createMockElement } from 'obsidian';

// Mock ConfirmModal.confirm() static so we can drive the archive confirm flow
// synthetically without rendering a real modal.
interface CapturedConfirmCall {
  app: unknown;
  config: {
    variant: 'delete' | 'remove' | 'archive';
    title: string;
    body: string;
    onConfirm?: () => void | Promise<void>;
  };
  resolve: (value: boolean) => void;
}

const capturedInstances: CapturedConfirmCall[] = [];

jest.mock('../../src/settings/components/ConfirmModal', () => ({
  ConfirmModal: {
    confirm: jest.fn().mockImplementation((app: unknown, config: CapturedConfirmCall['config']) => {
      return new Promise<boolean>((resolve) => {
        capturedInstances.push({ app, config, resolve });
      });
    })
  }
}));

import { StatesSectionRenderer, StatesSectionService, StateSummary } from '../../src/components/workspace/StatesSectionRenderer';

interface TestableStatesRenderer {
  workspaceId?: string;
  includeArchived: boolean;
  cachedStates: StateSummary[];
  listContainer?: HTMLElement;
  // private methods exposed for direct invocation
  toggleArchive(state: StateSummary): Promise<void>;
  confirmAndDelete(state: StateSummary): Promise<void>;
  // loadAndRender is private but visible via cast
  loadAndRender(): Promise<void>;
}

function makeService(overrides: Partial<jest.Mocked<StatesSectionService>> = {}): jest.Mocked<StatesSectionService> {
  return {
    listStates: jest.fn().mockResolvedValue([]),
    updateState: jest.fn().mockResolvedValue(undefined),
    archiveState: jest.fn().mockResolvedValue(undefined),
    deleteState: jest.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as jest.Mocked<StatesSectionService>;
}

function makeState(overrides: Partial<StateSummary> = {}): StateSummary {
  return {
    id: 'state-1',
    name: 'Snapshot',
    sessionId: 'sess-1',
    workspaceId: 'ws-1',
    created: 1_700_000_000_000,
    isArchived: false,
    ...overrides
  };
}

/** Drive the spy through a successful CTA-click cycle (resolves true). */
function clickCta(instance: CapturedConfirmCall): void {
  instance.resolve(true);
}

describe('StatesSectionRenderer port regression', () => {
  beforeEach(() => {
    capturedInstances.length = 0;
  });

  describe('render() — BoxedSection shell + workspaceId branch', () => {
    it('renders a "save first" hint inside BoxedSection when workspaceId is undefined', () => {
      const service = makeService();
      const renderer = new StatesSectionRenderer(new App(), service, new Component());
      const container = createMockElement('div');

      renderer.render(container, undefined);

      // BoxedSection emits a <section class="ws-section"> outer element.
      const section = container.querySelector('section.ws-section');
      expect(section).not.toBeNull();
      // Should NOT call listStates when there is no workspace yet.
      expect(service.listStates).not.toHaveBeenCalled();
    });

    it('calls listStates(workspaceId, includeArchived=false) on initial render', async () => {
      const service = makeService({
        listStates: jest.fn().mockResolvedValue([]) as jest.Mocked<StatesSectionService>['listStates']
      });
      const renderer = new StatesSectionRenderer(new App(), service, new Component());
      const container = createMockElement('div');

      renderer.render(container, 'ws-42');
      // loadAndRender is fire-and-forget — yield to let it run.
      await Promise.resolve();
      await Promise.resolve();

      expect(service.listStates).toHaveBeenCalledWith('ws-42', false);
    });
  });

  describe('Show archived toggle — both branches of the v5.9.7 fix', () => {
    it('calls listStates with includeArchived=false when toggle is OFF (default)', async () => {
      const service = makeService();
      const renderer = new StatesSectionRenderer(new App(), service, new Component()) as unknown as TestableStatesRenderer;
      renderer.workspaceId = 'ws-1';
      renderer.listContainer = createMockElement('div');
      renderer.includeArchived = false;

      await renderer.loadAndRender();

      expect(service.listStates).toHaveBeenCalledWith('ws-1', false);
    });

    it('calls listStates with includeArchived=true when toggle is ON', async () => {
      const service = makeService();
      const renderer = new StatesSectionRenderer(new App(), service, new Component()) as unknown as TestableStatesRenderer;
      renderer.workspaceId = 'ws-1';
      renderer.listContainer = createMockElement('div');
      renderer.includeArchived = true;

      await renderer.loadAndRender();

      expect(service.listStates).toHaveBeenCalledWith('ws-1', true);
    });

    it('surfaces archived states from the service unchanged (v5.9.7 contract)', async () => {
      // PR #218 fix guarantees getStates returns isArchived for tagged states.
      // The renderer must pass that through to its render path verbatim.
      const archivedState = makeState({
        id: 's-archived',
        name: 'Tagged snapshot',
        isArchived: true,
        tags: ['my-tag']
      });
      const service = makeService({
        listStates: jest.fn().mockResolvedValue([archivedState]) as jest.Mocked<StatesSectionService>['listStates']
      });
      const renderer = new StatesSectionRenderer(new App(), service, new Component()) as unknown as TestableStatesRenderer;
      renderer.workspaceId = 'ws-1';
      renderer.listContainer = createMockElement('div');
      renderer.includeArchived = true;

      await renderer.loadAndRender();

      expect(renderer.cachedStates).toHaveLength(1);
      expect(renderer.cachedStates[0].isArchived).toBe(true);
      expect(renderer.cachedStates[0].name).toBe('Tagged snapshot');
    });
  });

  describe('Archive flow — ConfirmModal accept → archiveState → refresh', () => {
    it('calls archiveState(workspaceId, sessionId, stateId, restore=false) after user confirms', async () => {
      const service = makeService();
      const renderer = new StatesSectionRenderer(new App(), service, new Component()) as unknown as TestableStatesRenderer;
      renderer.workspaceId = 'ws-1';
      renderer.listContainer = createMockElement('div');

      const state = makeState({ id: 's-1', sessionId: 'sess-1', isArchived: false });
      const pending = renderer.toggleArchive(state);

      // ConfirmModal mock captured; simulate user click on CTA.
      await Promise.resolve();
      expect(capturedInstances).toHaveLength(1);
      expect(capturedInstances[0].config.variant).toBe('archive');
      clickCta(capturedInstances[0]);

      await pending;

      expect(service.archiveState).toHaveBeenCalledWith('ws-1', 'sess-1', 's-1', false);
      // After archive, the list refreshes via loadAndRender → listStates.
      expect(service.listStates).toHaveBeenCalled();
    });

    it('does NOT call archiveState when user cancels the confirm modal', async () => {
      const service = makeService();
      const renderer = new StatesSectionRenderer(new App(), service, new Component()) as unknown as TestableStatesRenderer;
      renderer.workspaceId = 'ws-1';
      renderer.listContainer = createMockElement('div');

      const state = makeState({ id: 's-1', sessionId: 'sess-1', isArchived: false });
      const pending = renderer.toggleArchive(state);

      await Promise.resolve();
      // Cancel: resolve the captured ConfirmModal promise with false to
      // simulate the user clicking Cancel (helper static returns false).
      capturedInstances[0].resolve(false);

      await pending;

      expect(service.archiveState).not.toHaveBeenCalled();
    });

    it('SKIPS the confirm modal for restore (one-click reversal) and calls archiveState with restore=true', async () => {
      // Per CODE intent: restore is reversible-of-reversible, so no confirm
      // gate — the user gets immediate restoration.
      const service = makeService();
      const renderer = new StatesSectionRenderer(new App(), service, new Component()) as unknown as TestableStatesRenderer;
      renderer.workspaceId = 'ws-1';
      renderer.listContainer = createMockElement('div');

      const archived = makeState({ id: 's-archived', sessionId: 'sess-1', isArchived: true });
      await renderer.toggleArchive(archived);

      expect(capturedInstances).toHaveLength(0);
      expect(service.archiveState).toHaveBeenCalledWith('ws-1', 'sess-1', 's-archived', true);
    });

    it('shows a Notice and does not call archiveState when sessionId is missing', async () => {
      const service = makeService();
      const renderer = new StatesSectionRenderer(new App(), service, new Component()) as unknown as TestableStatesRenderer;
      renderer.workspaceId = 'ws-1';
      renderer.listContainer = createMockElement('div');

      const broken = makeState({ id: 's-1', sessionId: undefined });
      await renderer.toggleArchive(broken);

      expect(service.archiveState).not.toHaveBeenCalled();
      expect(capturedInstances).toHaveLength(0);
    });
  });

  describe('Delete flow — uses internal StateDeleteConfirmModal (NOT new ConfirmModal)', () => {
    /**
     * NOTE: The delete-state path still uses StateDeleteConfirmModal (the
     * pre-existing internal Modal subclass), NOT the new ConfirmModal
     * primitive. This is intentional for PR1 — the delete sweep is deferred
     * to a follow-up PR (out of scope per the commit body's "Out of scope"
     * list). We assert here that the delete path does NOT trigger our
     * captured ConfirmModal mock; if a future PR sweeps it, this test will
     * fail and signal the call-site count needs updating.
     */
    it('does NOT construct the shared ConfirmModal for delete (uses StateDeleteConfirmModal)', async () => {
      const service = makeService();
      const renderer = new StatesSectionRenderer(new App(), service, new Component()) as unknown as TestableStatesRenderer;
      renderer.workspaceId = 'ws-1';
      renderer.listContainer = createMockElement('div');

      const state = makeState({ id: 's-1', sessionId: 'sess-1' });
      // Fire-and-forget — the internal StateDeleteConfirmModal is not part
      // of our jest.mock, so the call dispatches into the real (mocked)
      // Modal base class. We only care that our shared ConfirmModal mock is
      // NOT touched.
      const pending = renderer.confirmAndDelete(state);
      await Promise.resolve();

      expect(capturedInstances).toHaveLength(0);

      // Cleanup: don't leave the promise dangling (StateDeleteConfirmModal's
      // resolver wires via constructor callback, won't fire here, so we
      // simply don't await pending — the test scope ends and Jest discards).
      void pending;
    });
  });
});
