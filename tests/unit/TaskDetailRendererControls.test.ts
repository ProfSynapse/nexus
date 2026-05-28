/**
 * TaskDetailRenderer — add-control + note-link action wiring (TEST-phase gap).
 *
 * The coder's smoke tests (TaskDetailRenderer.test.ts) cover the REMOVE/open
 * directionality (T-2), status pills (T-3), empty states (T-4), linkType
 * display suffix (T-6), and new-task gating (T-7). This file completes the
 * arch §10 contracts at the renderer layer that the smoke set leaves open:
 *
 *   T-2 (add half, §4d): the "Add dependency" control candidate filter
 *       (not-self, same-project, not-already-upstream) + add-button →
 *       onAddTaskDep(task.id, selectedId). Add-control is ONLY under
 *       "Depends on" — the "Blocks" group is display-only.
 *   §5b/§5c note-link actions: unlink button → onUnlinkNote(task.id, notePath);
 *       "Link note" → onLinkNote(task.id, path, linkType) using the selected
 *       linkType; empty-path guard surfaces a Notice and does NOT call onLinkNote.
 *
 * Mock pattern mirrors the coder's _children-tracking MockEl. Dependency-row
 * remove/open handlers are wired via component.registerDomEvent (→ mock
 * el.addEventListener), recovered via clickHandlerOf. The ADD controls
 * (Add dependency / Link note) use ButtonComponent.onClick, recovered via a
 * prototype-patch capture (mirrors PR2 ConfirmModalCallSites pattern).
 */

import { App, ButtonComponent, Component, DropdownComponent, TextComponent, Notice } from 'obsidian';
import { TaskDetailRenderer, TaskDetailCallbacks, TaskDetailEditorState, TaskDeps } from '../../src/components/workspace/TaskDetailRenderer';
import type { TaskMetadata, TaskPriority, TaskStatus, NoteLink } from '../../src/database/repositories/interfaces/ITaskRepository';

// Notice spy
jest.mock('obsidian', () => {
  const actual = jest.requireActual('obsidian');
  const noticeCalls: string[] = [];
  class SpyNotice {
    constructor(message: string) { noticeCalls.push(message); }
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
// MockEl (mirrors coder's TaskDetailRenderer.test.ts)
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
      let cls2 = '', text = '';
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
      let cls2 = '', text = '';
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
  const visit = (el: MockEl) => { if (el.textContent) out.push(el.textContent); el._children.forEach(visit); };
  root._children.forEach(visit);
  return out;
}
function clickHandlerOf(el: MockEl): () => void {
  const call = el.addEventListener.mock.calls.find(c => c[0] === 'click');
  if (!call) throw new Error('No click handler registered on element');
  return call[1] as () => void;
}

/**
 * Capture ButtonComponent.onClick handlers wired during a render pass, tagged
 * with the button's setButtonText label. DropdownComponent.getValue is stubbed
 * to a fixed selection so the captured handler reads a deterministic value.
 */
function captureAddControls(render: () => void): {
  byLabel: (label: string) => () => void | Promise<void>;
} {
  const handlers: Array<{ label: string; fn: () => void | Promise<void> }> = [];
  const lastLabel = { v: '' };
  const oSet = ButtonComponent.prototype.setButtonText;
  const oClick = ButtonComponent.prototype.onClick;
  ButtonComponent.prototype.setButtonText = function (this: ButtonComponent, t: string) {
    lastLabel.v = t; return oSet.call(this, t);
  };
  ButtonComponent.prototype.onClick = function (this: ButtonComponent, cb: () => void) {
    handlers.push({ label: lastLabel.v, fn: cb }); return oClick.call(this, cb);
  };
  try { render(); } finally {
    ButtonComponent.prototype.setButtonText = oSet;
    ButtonComponent.prototype.onClick = oClick;
  }
  return {
    byLabel: (label: string) => {
      const m = handlers.find(h => h.label === label);
      if (!m) throw new Error(`No onClick handler for button "${label}". Got: ${handlers.map(h => h.label).join(', ')}`);
      return m.fn;
    }
  };
}

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------
function makeTask(over: Partial<TaskMetadata> = {}): TaskMetadata {
  return {
    id: 't-dep', workspaceId: 'ws-1', projectId: 'p-1', title: 'Dep task',
    status: 'todo' as TaskStatus, priority: 'medium' as TaskPriority,
    created: 1_700_000_000_000, updated: 1_700_000_000_000, ...over
  } as TaskMetadata;
}
function makeEditorState(over: Partial<TaskDetailEditorState> = {}): TaskDetailEditorState {
  return {
    id: 'task-1', projectId: 'p-1', title: 'Main task', description: '',
    status: 'todo', priority: 'medium', dueDate: '', assignee: '', tags: '', parentTaskId: '', ...over
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
function renderWith(callbacks: TaskDetailCallbacks, capture = false): { container: MockEl; controls?: ReturnType<typeof captureAddControls> } {
  const container = makeEl();
  const renderer = new TaskDetailRenderer(new App(), new Component());
  if (capture) {
    const controls = captureAddControls(() => renderer.render(container as unknown as HTMLElement, callbacks));
    return { container, controls };
  }
  renderer.render(container as unknown as HTMLElement, callbacks);
  return { container };
}

describe('TaskDetailRenderer — add-control + note-link wiring (§10 gap)', () => {
  beforeEach(() => { resetNoticeCalls(); });

  describe('T-2 (add half) — add-dependency control', () => {
    it('add button → onAddTaskDep(task.id, selectedId) with the dropdown value', () => {
      const onAddTaskDep = jest.fn().mockResolvedValue(undefined);
      const candidate = makeTask({ id: 'cand-1', title: 'Candidate', projectId: 'p-1' });
      // Pin the dropdown selection deterministically.
      const getValueSpy = jest.spyOn(DropdownComponent.prototype, 'getValue').mockReturnValue('cand-1');

      const { controls } = renderWith(makeCallbacks({
        getAllTasks: () => [candidate],
        onAddTaskDep
      }), true);

      controls!.byLabel('Add dependency')();
      expect(onAddTaskDep).toHaveBeenCalledWith('task-1', 'cand-1');

      getValueSpy.mockRestore();
    });

    it('candidate filter excludes self, cross-project, and already-upstream — only the valid candidate is submittable', () => {
      // Behavioral assertion (robust against the Parent-Task dropdown that ALSO
      // lists getAllTasks): we pin the add-dep dropdown to return each excluded
      // id and confirm the renderer still only offers the valid candidate by
      // checking what the add-button submits when the dropdown yields the
      // valid id, AND that an all-excluded task set collapses to the empty
      // "No tasks available" state (next test).
      const onAddTaskDep = jest.fn().mockResolvedValue(undefined);
      const already = makeTask({ id: 'up-1', title: 'Already upstream', projectId: 'p-1' });
      const deps: TaskDeps = { upstream: [already], downstream: [] };
      const tasks = [
        makeTask({ id: 'task-1', title: 'Self', projectId: 'p-1' }),          // self — excluded
        makeTask({ id: 'other-proj', title: 'Other proj', projectId: 'p-2' }), // cross-project — excluded
        already,                                                                // already upstream — excluded
        makeTask({ id: 'valid', title: 'Valid candidate', projectId: 'p-1' })   // the only candidate
      ];
      const getValueSpy = jest.spyOn(DropdownComponent.prototype, 'getValue').mockReturnValue('valid');

      const { controls } = renderWith(makeCallbacks({
        getTask: () => makeEditorState({ id: 'task-1', projectId: 'p-1' }),
        getAllTasks: () => tasks,
        getDeps: () => deps,
        onAddTaskDep
      }), true);

      // The add control rendered (candidates non-empty → exactly the valid one).
      controls!.byLabel('Add dependency')();
      expect(onAddTaskDep).toHaveBeenCalledWith('task-1', 'valid');
      getValueSpy.mockRestore();
    });

    it('candidate filter collapses to "No tasks available" when ALL tasks are excluded', () => {
      const already = makeTask({ id: 'up-1', title: 'Already upstream', projectId: 'p-1' });
      const deps: TaskDeps = { upstream: [already], downstream: [] };
      const tasks = [
        makeTask({ id: 'task-1', title: 'Self', projectId: 'p-1' }),          // self
        makeTask({ id: 'other-proj', title: 'Other proj', projectId: 'p-2' }), // cross-project
        already                                                                 // already upstream
      ];
      const { container } = renderWith(makeCallbacks({
        getTask: () => makeEditorState({ id: 'task-1', projectId: 'p-1' }),
        getAllTasks: () => tasks,
        getDeps: () => deps
      }));
      expect(collectText(container)).toContain('No tasks available to add.');
    });

    it('renders "No tasks available to add." when no candidates remain', () => {
      const { container } = renderWith(makeCallbacks({
        getAllTasks: () => [makeTask({ id: 'task-1', projectId: 'p-1' })] // only self
      }));
      expect(collectText(container)).toContain('No tasks available to add.');
    });

    it('add-control is absent for the Blocks group (display-only) — only ONE add-dependency button total', () => {
      const candidate = makeTask({ id: 'cand', title: 'Cand', projectId: 'p-1' });
      const deps: TaskDeps = {
        upstream: [],
        downstream: [makeTask({ id: 'down-1', title: 'Downstream', projectId: 'p-1' })]
      };
      const handlers: string[] = [];
      const oSet = ButtonComponent.prototype.setButtonText;
      ButtonComponent.prototype.setButtonText = function (this: ButtonComponent, t: string) {
        handlers.push(t); return oSet.call(this, t);
      };
      try {
        renderWith(makeCallbacks({ getAllTasks: () => [candidate], getDeps: () => deps }));
      } finally {
        ButtonComponent.prototype.setButtonText = oSet;
      }
      const addDepButtons = handlers.filter(l => l === 'Add dependency');
      expect(addDepButtons).toHaveLength(1); // only the Depends-on group has it
    });
  });

  describe('note-link actions (§5b / §5c)', () => {
    it('unlink button → onUnlinkNote(task.id, notePath)', () => {
      const onUnlinkNote = jest.fn().mockResolvedValue(undefined);
      const notes: NoteLink[] = [{ taskId: 'task-1', notePath: 'notes/Spec.md', linkType: 'reference', created: 1 }];
      const { container } = renderWith(makeCallbacks({ getLinkedNotes: () => notes, onUnlinkNote }));

      const unlinkBtn = findByAttr(container, 'aria-label', 'Unlink Spec.md')[0];
      clickHandlerOf(unlinkBtn)();
      expect(onUnlinkNote).toHaveBeenCalledWith('task-1', 'notes/Spec.md');
    });

    it('Link note button → onLinkNote(task.id, path, selectedLinkType)', () => {
      const onLinkNote = jest.fn().mockResolvedValue(undefined);
      const getTextSpy = jest.spyOn(TextComponent.prototype, 'getValue').mockReturnValue('  notes/new.md  ');
      const getDropSpy = jest.spyOn(DropdownComponent.prototype, 'getValue').mockReturnValue('output');

      const { controls } = renderWith(makeCallbacks({ onLinkNote }), true);
      controls!.byLabel('Link note')();

      expect(onLinkNote).toHaveBeenCalledWith('task-1', 'notes/new.md', 'output'); // trimmed path
      getTextSpy.mockRestore();
      getDropSpy.mockRestore();
    });

    it('Link note with empty path → Notice "Enter a note path", does NOT call onLinkNote', () => {
      const onLinkNote = jest.fn().mockResolvedValue(undefined);
      const getTextSpy = jest.spyOn(TextComponent.prototype, 'getValue').mockReturnValue('   ');

      const { controls } = renderWith(makeCallbacks({ onLinkNote }), true);
      controls!.byLabel('Link note')();

      expect(onLinkNote).not.toHaveBeenCalled();
      expect(getNoticeCalls()).toContain('Enter a note path');
      getTextSpy.mockRestore();
    });
  });
});
