/**
 * ProjectsManagerView — Task-detail fetch-path + mutation + transition tests.
 *
 * Owns the arch §10 contracts that live at the ProjectsManagerView ADAPTER seam
 * (not the TaskDetailRenderer presentation layer the coder's smoke tests cover):
 *
 *   T-1 N+1 guard (§3d): openTaskDetail fetches getDependencyTree + getNoteLinks
 *       each EXACTLY ONCE per task-detail open, regardless of dep/note count.
 *       Plus a fs.readFile grep guard that getDependencies( / getDependents(
 *       appear NOWHERE in the renderer or the fetch path (mirrors PR2
 *       CheckboxSweepGuards pattern).
 *   T-5 Immediate per-edge mutation (D2): addTaskDep/removeTaskDep call the
 *       service immediately; on resolve the deps re-fetch (getDependencyTree
 *       called again) + re-render (onRender). On a cycle/cross-project THROW
 *       the error surfaces as a Notice and the displayed deps are NOT mutated
 *       (no refetch, no onRender) — the Notice carries the server's message so
 *       it is attributable to the exact edge the user attempted.
 *   T-8 Routing/reachability: openTaskDetailAndRender navigates to task-detail
 *       (onNavigateTaskDetail) after the single-call fetch; the project-detail
 *       "edit task" path routes through openTaskDetailAndRender so task-detail
 *       is reachable (the coder's PR2-unreachable fix).
 *
 * Seam: getTaskService() returns the cached `taskService` field if it is not
 * `undefined`, so we inject a jest-mocked TaskService by assigning the private
 * field directly. No ServiceManager needed.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { App, Component } from 'obsidian';
import { ProjectsManagerView, ProjectsManagerCallbacks } from '../../src/components/workspace/ProjectsManagerView';
import { WorkspaceDetailRenderer } from '../../src/components/workspace/WorkspaceDetailRenderer';
import type { TaskMetadata, TaskStatus } from '../../src/database/repositories/interfaces/ITaskRepository';

// ----------------------------------------------------------------------------
// Notice spy — assert error surfacing on cycle-throw without a real Notice.
// ----------------------------------------------------------------------------
jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian');
  const noticeCalls: string[] = [];
  class SpyNotice {
    constructor(message: string) {
      noticeCalls.push(message);
    }
  }
  return {
    ...actual,
    Notice: SpyNotice,
    __getNoticeCalls: () => noticeCalls,
    __resetNoticeCalls: () => { noticeCalls.length = 0; }
  };
});

function getNoticeCalls(): string[] {
  return (jest.requireMock('obsidian') as { __getNoticeCalls: () => string[] }).__getNoticeCalls();
}
function resetNoticeCalls(): void {
  (jest.requireMock('obsidian') as { __resetNoticeCalls: () => void }).__resetNoticeCalls();
}

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------
const ROOT = path.resolve(__dirname, '..', '..');

function makeTask(over: Partial<TaskMetadata> = {}): TaskMetadata {
  return {
    id: 't-1',
    workspaceId: 'ws-1',
    projectId: 'p-1',
    title: 'Task one',
    status: 'todo' as TaskStatus,
    priority: 'medium',
    created: 1_700_000_000_000,
    updated: 1_700_000_000_000,
    ...over
  } as TaskMetadata;
}

function treeNode(task: TaskMetadata) {
  return { task, dependencies: [], dependents: [] };
}

/** A mocked TaskService exposing only the methods the task-detail path uses. */
interface MockTaskService {
  getDependencyTree: jest.Mock;
  getNoteLinks: jest.Mock;
  addDependency: jest.Mock;
  removeDependency: jest.Mock;
  linkNote: jest.Mock;
  unlinkNote: jest.Mock;
}

function makeService(over: Partial<MockTaskService> = {}): MockTaskService {
  return {
    getDependencyTree: jest.fn().mockResolvedValue({ task: makeTask(), dependencies: [], dependents: [] }),
    getNoteLinks: jest.fn().mockResolvedValue([]),
    addDependency: jest.fn().mockResolvedValue(undefined),
    removeDependency: jest.fn().mockResolvedValue(undefined),
    linkNote: jest.fn().mockResolvedValue(undefined),
    unlinkNote: jest.fn().mockResolvedValue(undefined),
    ...over
  };
}

interface Harness {
  pmv: ProjectsManagerView;
  service: MockTaskService;
  callbacks: jest.Mocked<ProjectsManagerCallbacks>;
}

function makeHarness(service: MockTaskService = makeService()): Harness {
  const callbacks = {
    getCurrentWorkspace: jest.fn(() => ({ id: 'ws-1', name: 'WS' })),
    onNavigateList: jest.fn(),
    onNavigateDetail: jest.fn(),
    onNavigateProjectDetail: jest.fn(),
    onNavigateTaskDetail: jest.fn(),
    onRender: jest.fn(),
    buildDetailCallbacks: jest.fn(() => ({} as never)),
    getApp: jest.fn(() => new App()),
    getComponent: jest.fn(() => new Component())
  } as unknown as jest.Mocked<ProjectsManagerCallbacks>;

  const detailRenderer = new WorkspaceDetailRenderer(new Component());
  const pmv = new ProjectsManagerView(detailRenderer, undefined, callbacks);

  // Inject the mocked service + a current project so openTaskDetail proceeds.
  (pmv as unknown as { taskService: MockTaskService }).taskService = service;
  (pmv as unknown as { currentProject: unknown }).currentProject = {
    id: 'p-1', workspaceId: 'ws-1', name: 'Project', description: '', status: 'active'
  };

  return { pmv, service, callbacks };
}

describe('ProjectsManagerView — task-detail seam (T-1 / T-5 / T-8)', () => {
  beforeEach(() => {
    resetNoticeCalls();
  });

  // ==========================================================================
  // T-1 — N+1 guard
  // ==========================================================================
  describe('T-1 — N+1 guard (single-call fetch at navigation)', () => {
    it('openTaskDetail calls getDependencyTree + getNoteLinks EXACTLY once each', async () => {
      const { pmv, service } = makeHarness();
      await pmv.openTaskDetail(makeTask({ id: 't-1' }));

      expect(service.getDependencyTree).toHaveBeenCalledTimes(1);
      expect(service.getNoteLinks).toHaveBeenCalledTimes(1);
      expect(service.getDependencyTree).toHaveBeenCalledWith('t-1');
      expect(service.getNoteLinks).toHaveBeenCalledWith('t-1');
    });

    it('fetch count is INDEPENDENT of dependency / note count (O(1), not O(N))', async () => {
      // 50 upstream + 50 downstream deps + 50 notes — still exactly one call each.
      const upstream = Array.from({ length: 50 }, (_, i) => treeNode(makeTask({ id: `u-${i}` })));
      const downstream = Array.from({ length: 50 }, (_, i) => treeNode(makeTask({ id: `d-${i}` })));
      const notes = Array.from({ length: 50 }, (_, i) => ({
        taskId: 't-1', notePath: `n-${i}.md`, linkType: 'reference' as const, created: 1
      }));
      const service = makeService({
        getDependencyTree: jest.fn().mockResolvedValue({ task: makeTask(), dependencies: upstream, dependents: downstream }),
        getNoteLinks: jest.fn().mockResolvedValue(notes)
      });
      const { pmv } = makeHarness(service);

      await pmv.openTaskDetail(makeTask({ id: 't-1' }));

      expect(service.getDependencyTree).toHaveBeenCalledTimes(1);
      expect(service.getNoteLinks).toHaveBeenCalledTimes(1);
    });

    it('a NEW (unsaved) task fetches NOTHING (no id → no edges/links)', async () => {
      const { pmv, service } = makeHarness();
      await pmv.openTaskDetail(undefined);

      expect(service.getDependencyTree).not.toHaveBeenCalled();
      expect(service.getNoteLinks).not.toHaveBeenCalled();
    });

    it('GREP GUARD — getDependencies( / getDependents( appear NOWHERE in renderer or fetch path', async () => {
      // The N+1 trap would resolve each dep row via getDependencies(taskId) +
      // getById. The arch (§3d) requires those per-row fetch calls be absent
      // from the renderer AND the ProjectsManagerView fetch path. fs.readFile +
      // regex (CI/Windows-portable, no shell-out — mirrors PR2 CheckboxSweepGuards).
      const files = [
        path.join(ROOT, 'src/components/workspace/TaskDetailRenderer.ts'),
        path.join(ROOT, 'src/components/workspace/ProjectsManagerView.ts')
      ];
      const banned = [/\bgetDependencies\s*\(/, /\bgetDependents\s*\(/];
      const hits: string[] = [];
      for (const file of files) {
        const text = await fs.readFile(file, 'utf8');
        text.split(/\r?\n/).forEach((line, i) => {
          for (const re of banned) {
            if (re.test(line)) {
              hits.push(`${path.relative(ROOT, file)}:${i + 1} → ${line.trim().slice(0, 100)}`);
            }
          }
        });
      }
      expect(hits).toEqual([]);
    });
  });

  // ==========================================================================
  // T-5 — immediate per-edge mutation + cycle-throw → Notice → no mutation
  // ==========================================================================
  describe('T-5 — immediate per-edge mutation', () => {
    it('addTaskDep calls addDependency immediately, then re-fetches + re-renders + refreshes displayed deps', async () => {
      const newUpstream = makeTask({ id: 'dep-2', title: 'New upstream' });
      const service = makeService({
        getDependencyTree: jest.fn()
          .mockResolvedValueOnce({ task: makeTask(), dependencies: [], dependents: [] })       // at-navigation
          .mockResolvedValueOnce({ task: makeTask(), dependencies: [treeNode(newUpstream)], dependents: [] }) // post-add refetch
      });
      const { pmv, callbacks } = makeHarness(service);
      // Seed currentTask so refetchCurrentTaskDeps has an id.
      await pmv.openTaskDetail(makeTask({ id: 't-1' }));
      expect((pmv as unknown as { currentTaskDeps: TaskDeps }).currentTaskDeps.upstream).toEqual([]);
      callbacks.onRender.mockClear();

      await (pmv as unknown as { addTaskDep: (a: string, b: string) => Promise<void> }).addTaskDep('t-1', 'dep-2');

      expect(service.addDependency).toHaveBeenCalledWith('t-1', 'dep-2');
      // Re-fetch after mutation (immediate, single call) — total 2 (nav + refetch).
      expect(service.getDependencyTree).toHaveBeenCalledTimes(2);
      expect(callbacks.onRender).toHaveBeenCalledTimes(1);
      // Displayed deps now reflect the refetch (state-refresh, not just a call).
      expect((pmv as unknown as { currentTaskDeps: TaskDeps }).currentTaskDeps.upstream.map(t => t.id)).toEqual(['dep-2']);
    });

    it('removeTaskDep calls removeDependency immediately, then re-fetches + re-renders', async () => {
      const { pmv, service, callbacks } = makeHarness();
      await pmv.openTaskDetail(makeTask({ id: 't-1' }));
      service.getDependencyTree.mockClear();
      callbacks.onRender.mockClear();

      await (pmv as unknown as { removeTaskDep: (a: string, b: string) => Promise<void> }).removeTaskDep('t-1', 'dep-2');

      expect(service.removeDependency).toHaveBeenCalledWith('t-1', 'dep-2');
      expect(service.getDependencyTree).toHaveBeenCalledTimes(1);
      expect(callbacks.onRender).toHaveBeenCalledTimes(1);
    });

    it('cycle-throw on add → Notice with the server message + NO mutation of displayed deps', async () => {
      const cycleError = new Error('Adding this dependency would create a cycle');
      const service = makeService({
        addDependency: jest.fn().mockRejectedValue(cycleError)
      });
      const { pmv, callbacks } = makeHarness(service);
      await pmv.openTaskDetail(makeTask({ id: 't-1' }));

      // Capture displayed deps BEFORE the failed add.
      const before = (pmv as unknown as { currentTaskDeps: unknown }).currentTaskDeps;
      service.getDependencyTree.mockClear();
      callbacks.onRender.mockClear();
      resetNoticeCalls();

      await (pmv as unknown as { addTaskDep: (a: string, b: string) => Promise<void> }).addTaskDep('t-1', 'dep-cycle');

      // Notice surfaced the EXACT server message (attributable to this edge).
      expect(getNoticeCalls()).toEqual(['Adding this dependency would create a cycle']);
      // NO re-fetch and NO re-render — the displayed list is untouched.
      expect(service.getDependencyTree).not.toHaveBeenCalled();
      expect(callbacks.onRender).not.toHaveBeenCalled();
      const after = (pmv as unknown as { currentTaskDeps: unknown }).currentTaskDeps;
      expect(after).toBe(before); // same reference — not replaced
    });

    it('cross-project throw on add → Notice carries the server message verbatim', async () => {
      const xprojError = new Error('Cannot add dependency across projects');
      const service = makeService({ addDependency: jest.fn().mockRejectedValue(xprojError) });
      const { pmv } = makeHarness(service);
      await pmv.openTaskDetail(makeTask({ id: 't-1' }));
      resetNoticeCalls();

      await (pmv as unknown as { addTaskDep: (a: string, b: string) => Promise<void> }).addTaskDep('t-1', 'dep-x');

      expect(getNoticeCalls()).toEqual(['Cannot add dependency across projects']);
    });

    it('non-Error throw on add → falls back to generic Notice copy', async () => {
      const service = makeService({ addDependency: jest.fn().mockRejectedValue('weird non-error') });
      const { pmv } = makeHarness(service);
      await pmv.openTaskDetail(makeTask({ id: 't-1' }));
      resetNoticeCalls();

      await (pmv as unknown as { addTaskDep: (a: string, b: string) => Promise<void> }).addTaskDep('t-1', 'dep-x');

      expect(getNoticeCalls()).toEqual(['Failed to add dependency']);
    });

    it('linkNote / unlinkNote mutate immediately then re-fetch notes + re-render', async () => {
      const { pmv, service, callbacks } = makeHarness();
      await pmv.openTaskDetail(makeTask({ id: 't-1' }));
      service.getNoteLinks.mockClear();
      callbacks.onRender.mockClear();

      await (pmv as unknown as { linkNote: (a: string, b: string, c: string) => Promise<void> }).linkNote('t-1', 'notes/x.md', 'reference');
      expect(service.linkNote).toHaveBeenCalledWith('t-1', 'notes/x.md', 'reference');
      expect(service.getNoteLinks).toHaveBeenCalledTimes(1);
      expect(callbacks.onRender).toHaveBeenCalledTimes(1);

      service.getNoteLinks.mockClear();
      callbacks.onRender.mockClear();
      await (pmv as unknown as { unlinkNote: (a: string, b: string) => Promise<void> }).unlinkNote('t-1', 'notes/x.md');
      expect(service.unlinkNote).toHaveBeenCalledWith('t-1', 'notes/x.md');
      expect(service.getNoteLinks).toHaveBeenCalledTimes(1);
      expect(callbacks.onRender).toHaveBeenCalledTimes(1);
    });

    it('note-link re-render path (refetchCurrentTaskNotes) refreshes the DISPLAYED notes — symmetric to the dep re-render path', async () => {
      // Auditor ADD: the dep mutation path re-fetches getDependencyTree and
      // re-renders; assert the SYMMETRIC note path — after linkNote, the
      // refetchCurrentTaskNotes result actually replaces currentTaskLinkedNotes
      // (not just that getNoteLinks was called). Mirrors the dep-side state-
      // refresh rigor so a "fetched but never stored" regression is caught.
      const linkedAfter = [
        { taskId: 't-1', notePath: 'notes/x.md', linkType: 'reference' as const, created: 1 }
      ];
      const service = makeService({
        // First call (at-navigation) returns empty; second call (post-mutation
        // refetch) returns the newly-linked note.
        getNoteLinks: jest.fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce(linkedAfter)
      });
      const { pmv } = makeHarness(service);
      await pmv.openTaskDetail(makeTask({ id: 't-1' }));

      // Displayed notes start empty (the at-navigation fetch).
      expect((pmv as unknown as { currentTaskLinkedNotes: unknown[] }).currentTaskLinkedNotes).toEqual([]);

      await (pmv as unknown as { linkNote: (a: string, b: string, c: string) => Promise<void> }).linkNote('t-1', 'notes/x.md', 'reference');

      // The post-mutation refetch result is now the displayed state.
      expect((pmv as unknown as { currentTaskLinkedNotes: unknown[] }).currentTaskLinkedNotes).toEqual(linkedAfter);
    });

    it('note-link mutation FAILURE → Notice + NO state mutation + NO re-render (symmetric to dep cycle-guard)', async () => {
      // Mirror of the dep cycle-guard on the note side: linkNote throws → the
      // generic Notice fires, the early-return prevents refetch + re-render, and
      // the displayed notes are untouched.
      const service = makeService({
        getNoteLinks: jest.fn().mockResolvedValue([]),
        linkNote: jest.fn().mockRejectedValue(new Error('storage write failed'))
      });
      const { pmv, callbacks } = makeHarness(service);
      await pmv.openTaskDetail(makeTask({ id: 't-1' }));
      const before = (pmv as unknown as { currentTaskLinkedNotes: unknown }).currentTaskLinkedNotes;
      service.getNoteLinks.mockClear();
      callbacks.onRender.mockClear();
      resetNoticeCalls();

      await (pmv as unknown as { linkNote: (a: string, b: string, c: string) => Promise<void> }).linkNote('t-1', 'notes/x.md', 'reference');

      expect(getNoticeCalls()).toEqual(['Failed to link note']);
      expect(service.getNoteLinks).not.toHaveBeenCalled(); // no refetch
      expect(callbacks.onRender).not.toHaveBeenCalled();   // no re-render
      const after = (pmv as unknown as { currentTaskLinkedNotes: unknown }).currentTaskLinkedNotes;
      expect(after).toBe(before); // displayed notes untouched
    });
  });

  // ==========================================================================
  // T-8 — routing / reachability
  // ==========================================================================
  describe('T-8 — routing + reachability', () => {
    it('openTaskDetailAndRender navigates to task-detail after the fetch', async () => {
      const { pmv, service, callbacks } = makeHarness();

      await pmv.openTaskDetailAndRender(makeTask({ id: 't-1' }));

      // Fetch happened first (single-call), THEN navigation fired.
      expect(service.getDependencyTree).toHaveBeenCalledTimes(1);
      expect(callbacks.onNavigateTaskDetail).toHaveBeenCalledTimes(1);
    });

    it('does NOT navigate when the task could not be opened (no current project)', async () => {
      const { pmv, callbacks } = makeHarness();
      // Clear currentProject so openTaskDetail bails before setting currentTask.
      (pmv as unknown as { currentProject: unknown }).currentProject = null;

      await pmv.openTaskDetailAndRender(makeTask({ id: 't-1' }));

      expect(callbacks.onNavigateTaskDetail).not.toHaveBeenCalled();
    });

    it('REACHABILITY — project-detail "edit task" path routes through openTaskDetailAndRender', async () => {
      // renderProjectDetail wires the edit-task callback as
      // (task?) => void this.openTaskDetailAndRender(task). We assert that
      // invoking the wired callback drives the navigation transition, proving
      // task-detail is reachable from project-detail (the coder's PR2-unreachable
      // fix). We spy on openTaskDetailAndRender to confirm the wiring.
      const { pmv, callbacks } = makeHarness();
      const spy = jest
        .spyOn(pmv, 'openTaskDetailAndRender')
        .mockResolvedValue(undefined);

      // Drive renderProjectDetail: the 8th positional arg is the edit-task cb.
      // We capture it via the detailRenderer mock's renderProjectDetail call.
      const detailRenderer = (pmv as unknown as { detailRenderer: WorkspaceDetailRenderer }).detailRenderer;
      const renderSpy = jest
        .spyOn(detailRenderer, 'renderProjectDetail')
        .mockImplementation(((...args: unknown[]) => {
          const editTaskCb = args[7] as (task?: TaskMetadata) => void;
          editTaskCb(makeTask({ id: 'edit-me' }));
        }) as never);

      const container = new App().workspace ? ({} as HTMLElement) : ({} as HTMLElement);
      pmv.renderProjectDetail(container);

      expect(renderSpy).toHaveBeenCalled();
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: 'edit-me' }));
      expect(callbacks.onNavigateProjectDetail).not.toHaveBeenCalled(); // edit-task does NOT go back to project list

      spy.mockRestore();
      renderSpy.mockRestore();
    });
  });
});
