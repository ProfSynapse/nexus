/**
 * TaskDetailRenderer — Wave 3 PR3 CODE-phase smoke tests.
 *
 * Covers the highest-risk contracts from the arch §10 test list (full coverage
 * is the test-engineer's TEST phase):
 *   T-2 Deps directionality — upstream remove → onRemoveTaskDep(task.id, depId);
 *       downstream remove → onRemoveTaskDep(depId, task.id); add → onAddTaskDep(task.id, sel).
 *   T-3 Status-pill matrix — todo/in_progress/cancelled render a pill; done renders none.
 *   T-4 Empty states — the three empty-state copies render when collections are empty.
 *   T-6 linkType suffix (D3) — every note-link description ends with `· {linkType}`.
 *   T-7 New-task gating — a task with no id renders Task-details but NOT deps/notes.
 *
 * Uses the local _children-tracking MockContainer pattern (mirrors
 * ProjectDetailRenderer.test.ts). registerDomEvent → el.addEventListener (mock);
 * click handlers are recovered from the button's addEventListener.mock.calls.
 */

import { App, Component } from 'obsidian';
import { TaskDetailRenderer, TaskDetailCallbacks, TaskDetailEditorState, TaskDeps } from '../../src/components/workspace/TaskDetailRenderer';
import type { TaskMetadata, TaskPriority, TaskStatus, NoteLink, LinkType } from '../../src/database/repositories/interfaces/ITaskRepository';

// ----------------------------------------------------------------------------
// Local MockContainer w/ _children + attribute + event-handler tracking
// ----------------------------------------------------------------------------
type MockEl = {
  tagName: string;
  className: string;
  attributes: Record<string, string>;
  createEl: jest.Mock<MockEl, [string, unknown?]>;
  createDiv: jest.Mock<MockEl, [unknown?]>;
  createSpan: jest.Mock<MockEl, [unknown?]>;
  addClass: jest.Mock<void, [string]>;
  setAttribute: jest.Mock<void, [string, string]>;
  empty: jest.Mock<void, []>;
  addEventListener: jest.Mock<void, [string, EventListenerOrEventListenerObject]>;
  removeEventListener: jest.Mock<void, []>;
  textContent: string;
  _children: MockEl[];
};

function makeEl(cls = '', tag = 'DIV'): MockEl {
  const el: MockEl = {
    tagName: tag.toUpperCase(),
    className: cls,
    attributes: {},
    createEl: jest.fn((t?: string, opts?: { cls?: string; text?: string; attr?: Record<string, string> }) => {
      const c = makeEl(opts?.cls || '', (t || 'DIV').toUpperCase());
      if (opts?.text) c.textContent = opts.text;
      if (opts?.attr) Object.assign(c.attributes, opts.attr);
      el._children.push(c);
      return c;
    }),
    createDiv: jest.fn((arg?: unknown) => {
      let cls2 = '';
      let text = '';
      if (typeof arg === 'string') cls2 = arg;
      else if (arg && typeof arg === 'object') {
        cls2 = String((arg as { cls?: string }).cls ?? '');
        text = String((arg as { text?: string }).text ?? '');
      }
      const child = makeEl(cls2);
      if (text) child.textContent = text;
      el._children.push(child);
      return child;
    }),
    createSpan: jest.fn((arg?: unknown) => {
      let cls2 = '';
      let text = '';
      if (arg && typeof arg === 'object') {
        cls2 = String((arg as { cls?: string }).cls ?? '');
        text = String((arg as { text?: string }).text ?? '');
      }
      const child = makeEl(cls2, 'SPAN');
      if (text) child.textContent = text;
      el._children.push(child);
      return child;
    }),
    addClass: jest.fn((c: string) => { el.className = `${el.className} ${c}`.trim(); }),
    setAttribute: jest.fn((k: string, v: string) => { el.attributes[k] = v; }),
    empty: jest.fn(() => { el._children.length = 0; }),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    textContent: '',
    _children: []
  };
  return el;
}

function findAllByClassFragment(root: MockEl, fragment: string): MockEl[] {
  const out: MockEl[] = [];
  const visit = (el: MockEl) => {
    if (el.className.split(/\s+/).some(c => c === fragment)) out.push(el);
    el._children.forEach(visit);
  };
  root._children.forEach(visit);
  return out;
}

function findByAttr(root: MockEl, key: string, value: string): MockEl[] {
  const out: MockEl[] = [];
  const visit = (el: MockEl) => {
    if (el.attributes[key] === value) out.push(el);
    el._children.forEach(visit);
  };
  root._children.forEach(visit);
  return out;
}

function collectText(root: MockEl): string[] {
  const out: string[] = [];
  const visit = (el: MockEl) => {
    if (el.textContent) out.push(el.textContent);
    el._children.forEach(visit);
  };
  root._children.forEach(visit);
  return out;
}

/** Recover the click handler registered on an element via registerDomEvent. */
function clickHandlerOf(el: MockEl): () => void {
  const call = el.addEventListener.mock.calls.find(c => c[0] === 'click');
  if (!call) throw new Error('No click handler registered on element');
  return call[1] as () => void;
}

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------
function makeTask(over: Partial<TaskMetadata> = {}): TaskMetadata {
  return {
    id: 't-dep',
    workspaceId: 'ws-1',
    projectId: 'p-1',
    title: 'Dep task',
    status: 'todo' as TaskStatus,
    priority: 'medium' as TaskPriority,
    created: 1_700_000_000_000,
    updated: 1_700_000_000_000,
    ...over
  } as TaskMetadata;
}

function makeEditorState(over: Partial<TaskDetailEditorState> = {}): TaskDetailEditorState {
  return {
    id: 'task-1',
    projectId: 'p-1',
    title: 'Main task',
    description: '',
    status: 'todo',
    priority: 'medium',
    dueDate: '',
    assignee: '',
    tags: '',
    parentTaskId: '',
    ...over
  };
}

function makeCallbacks(over: Partial<TaskDetailCallbacks> = {}): TaskDetailCallbacks {
  const deps: TaskDeps = { upstream: [], downstream: [] };
  return {
    getWorkspace: () => ({ id: 'ws-1', name: 'Workspace' }),
    getProject: () => ({ id: 'p-1', name: 'Project' }),
    getTask: () => makeEditorState(),
    getAllProjects: () => [{ id: 'p-1', name: 'Project' }] as never[],
    getAllTasks: () => [],
    getDeps: () => deps,
    getLinkedNotes: () => [],
    onNavigateList: jest.fn(),
    onNavigateDetail: jest.fn(),
    onNavigateProjects: jest.fn(),
    onNavigateProjectDetail: jest.fn(),
    onOpenTaskDetail: jest.fn(),
    onSaveTask: jest.fn().mockResolvedValue(undefined),
    onDeleteTask: jest.fn().mockResolvedValue(undefined),
    onAddTaskDep: jest.fn().mockResolvedValue(undefined),
    onRemoveTaskDep: jest.fn().mockResolvedValue(undefined),
    onLinkNote: jest.fn().mockResolvedValue(undefined),
    onUnlinkNote: jest.fn().mockResolvedValue(undefined),
    getApp: () => new App(),
    ...over
  };
}

function render(callbacks: TaskDetailCallbacks): MockEl {
  const container = makeEl();
  const renderer = new TaskDetailRenderer(new App(), new Component());
  renderer.render(container as unknown as HTMLElement, callbacks);
  return container;
}

describe('TaskDetailRenderer — PR3 smoke', () => {
  describe('T-7 — new-task gating', () => {
    it('renders Task details but NOT Dependencies / Linked notes for an unsaved task', () => {
      const container = render(makeCallbacks({ getTask: () => makeEditorState({ id: undefined }) }));
      const titles = findAllByClassFragment(container, 'ws-section-title').map(e => e.textContent);
      expect(titles).toContain('Task details');
      expect(titles).not.toContain('Dependencies');
      expect(titles).not.toContain('Linked notes');
    });

    it('renders all three sections for a saved task', () => {
      const container = render(makeCallbacks());
      const titles = findAllByClassFragment(container, 'ws-section-title').map(e => e.textContent);
      expect(titles).toContain('Task details');
      expect(titles).toContain('Dependencies');
      expect(titles).toContain('Linked notes');
    });
  });

  describe('T-4 — empty states', () => {
    it('renders the three empty-state copies when deps + notes are empty', () => {
      const container = render(makeCallbacks());
      const text = collectText(container);
      expect(text).toContain('No upstream dependencies.');
      expect(text).toContain('No tasks blocked by this one.');
      expect(text).toContain('No linked notes yet.');
    });
  });

  describe('T-3 — status-pill matrix', () => {
    it('renders a pill for todo / in_progress / cancelled but NOT done', () => {
      const deps: TaskDeps = {
        upstream: [
          makeTask({ id: 'u-todo', title: 'U todo', status: 'todo' }),
          makeTask({ id: 'u-prog', title: 'U prog', status: 'in_progress' }),
          makeTask({ id: 'u-done', title: 'U done', status: 'done' }),
          makeTask({ id: 'u-cancel', title: 'U cancel', status: 'cancelled' })
        ],
        downstream: []
      };
      const container = render(makeCallbacks({ getDeps: () => deps }));

      const pills = findAllByClassFragment(container, 'ws-status-pill');
      expect(pills).toHaveLength(3);
      const pillClasses = pills.map(p => p.className);
      expect(pillClasses.some(c => c.includes('is-todo'))).toBe(true);
      expect(pillClasses.some(c => c.includes('is-in_progress'))).toBe(true);
      expect(pillClasses.some(c => c.includes('is-cancelled'))).toBe(true);
      expect(pillClasses.some(c => c.includes('is-done'))).toBe(false);
    });
  });

  describe('T-2 — deps directionality', () => {
    it('upstream remove → onRemoveTaskDep(task.id, depTask.id)', () => {
      const onRemoveTaskDep = jest.fn().mockResolvedValue(undefined);
      const deps: TaskDeps = {
        upstream: [makeTask({ id: 'dep-up', title: 'Upstream dep' })],
        downstream: []
      };
      const container = render(makeCallbacks({ getDeps: () => deps, onRemoveTaskDep }));

      const removeBtn = findByAttr(container, 'aria-label', 'Remove dependency')[0];
      clickHandlerOf(removeBtn)();
      expect(onRemoveTaskDep).toHaveBeenCalledWith('task-1', 'dep-up');
    });

    it('downstream remove → onRemoveTaskDep(depTask.id, task.id) (inverted)', () => {
      const onRemoveTaskDep = jest.fn().mockResolvedValue(undefined);
      const deps: TaskDeps = {
        upstream: [],
        downstream: [makeTask({ id: 'dep-down', title: 'Downstream dep' })]
      };
      const container = render(makeCallbacks({ getDeps: () => deps, onRemoveTaskDep }));

      const removeBtn = findByAttr(container, 'aria-label', 'Remove dependency')[0];
      clickHandlerOf(removeBtn)();
      expect(onRemoveTaskDep).toHaveBeenCalledWith('dep-down', 'task-1');
    });

    it('dep-row open button → onOpenTaskDetail(depTask)', () => {
      const onOpenTaskDetail = jest.fn();
      const upstreamTask = makeTask({ id: 'dep-up', title: 'Upstream dep' });
      const deps: TaskDeps = { upstream: [upstreamTask], downstream: [] };
      const container = render(makeCallbacks({ getDeps: () => deps, onOpenTaskDetail }));

      const openBtn = findByAttr(container, 'aria-label', 'Open Upstream dep')[0];
      clickHandlerOf(openBtn)();
      expect(onOpenTaskDetail).toHaveBeenCalledWith(upstreamTask);
    });
  });

  describe('T-6 — linkType always-suffix (D3)', () => {
    it('renders every note-link description as `notePath · linkType`', () => {
      const notes: NoteLink[] = (['reference', 'output', 'input'] as LinkType[]).map((linkType, i) => ({
        taskId: 'task-1',
        notePath: `notes/file-${i}.md`,
        linkType,
        created: 1_700_000_000_000
      }));
      const container = render(makeCallbacks({ getLinkedNotes: () => notes }));

      const descriptions = findAllByClassFragment(container, 'setting-item-description').map(e => e.textContent);
      expect(descriptions).toContain('notes/file-0.md · reference');
      expect(descriptions).toContain('notes/file-1.md · output');
      expect(descriptions).toContain('notes/file-2.md · input');
      // Every description carries a ` · {linkType}` suffix (no bare path).
      for (const desc of descriptions) {
        expect(desc).toMatch(/ · (reference|output|input)$/);
      }
    });

    it('note-link basename appears in setting-item-name', () => {
      const notes: NoteLink[] = [{
        taskId: 'task-1', notePath: 'deep/nested/Spec.md', linkType: 'reference', created: 1_700_000_000_000
      }];
      const container = render(makeCallbacks({ getLinkedNotes: () => notes }));
      const names = findAllByClassFragment(container, 'setting-item-name').map(e => e.textContent);
      expect(names).toContain('Spec.md');
    });
  });
});
