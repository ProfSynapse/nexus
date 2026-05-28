/**
 * ProjectDetailRenderer — Row-Primitive Characterization Tests (C-6)
 *
 * Asserts the V3 row contract emitted by ProjectDetailRenderer.renderTaskRow:
 *   - Row is a `<div class="setting-item is-task">` (plus ` is-done` when status=done).
 *   - Row has `data-depth` attribute reflecting DFS depth.
 *   - Each row has exactly 2 icon-buttons in `.setting-item-control` (Edit, Delete);
 *     NO leading checkbox (PR2 checkbox sweep).
 *   - Meta region holds priority dot + status text; due/assignee spans appear conditionally.
 *   - Tasks built via TaskRowBuilder.buildRows — DFS-ordered, parent-first, depth-indented.
 */

import { App, Component } from 'obsidian';
import { ProjectDetailRenderer, ProjectDetailEditorState, ProjectDetailCallbacks } from '../../src/components/workspace/ProjectDetailRenderer';
import type { TaskMetadata, TaskPriority, TaskStatus } from '../../src/database/repositories/interfaces/ITaskRepository';

// ----------------------------------------------------------------------------
// Local MockContainer w/ _children + attribute tracking
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
      if (typeof arg === 'string') cls2 = arg;
      else if (arg && typeof arg === 'object' && 'cls' in (arg as Record<string, unknown>)) {
        cls2 = String((arg as { cls?: string }).cls ?? '');
      }
      const child = makeEl(cls2);
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
    if (el.className.split(/\s+/).some(c => c === fragment) || el.className.includes(fragment)) {
      out.push(el);
    }
    el._children.forEach(visit);
  };
  root._children.forEach(visit);
  return out;
}

function findAllByTag(root: MockEl, tag: string): MockEl[] {
  const out: MockEl[] = [];
  const visit = (el: MockEl) => {
    if (el.tagName === tag.toUpperCase()) out.push(el);
    el._children.forEach(visit);
  };
  root._children.forEach(visit);
  return out;
}

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------
function makeTask(over: Partial<TaskMetadata> = {}): TaskMetadata {
  return {
    id: 't-1',
    workspaceId: 'ws-1',
    projectId: 'p-1',
    title: 'Task one',
    status: 'todo' as TaskStatus,
    priority: 'medium' as TaskPriority,
    created: 1_700_000_000_000,
    updated: 1_700_000_000_000,
    ...over
  } as TaskMetadata;
}

function makeCallbacks(over: Partial<ProjectDetailCallbacks> = {}): ProjectDetailCallbacks {
  return {
    getWorkspace: () => ({ id: 'ws-1', name: 'Workspace' }),
    getProject: () => ({
      id: 'p-1',
      workspaceId: 'ws-1',
      name: 'Project',
      description: '',
      status: 'active'
    } as ProjectDetailEditorState),
    getTasks: () => [],
    onNavigateList: jest.fn(),
    onNavigateDetail: jest.fn(),
    onNavigateProjects: jest.fn(),
    onSaveProject: jest.fn().mockResolvedValue(undefined),
    onDeleteProject: jest.fn().mockResolvedValue(undefined),
    onOpenTaskDetail: jest.fn(),
    onDeleteTask: jest.fn().mockResolvedValue(undefined),
    ...over
  };
}

describe('ProjectDetailRenderer — row primitive characterization (C-6)', () => {
  it('emits a setting-item.is-task row per task (no leading checkbox)', () => {
    const container = makeEl();
    const renderer = new ProjectDetailRenderer(new App(), new Component());
    const tasks = [makeTask({ id: 't-1', title: 'Alpha' })];

    renderer.render(container as unknown as HTMLElement, makeCallbacks({ getTasks: () => tasks }));

    const rows = findAllByClassFragment(container, 'is-task');
    expect(rows.length).toBe(1);
    expect(rows[0].className).toContain('setting-item');
    expect(rows[0].className).toContain('is-task');
  });

  it('adds is-done modifier only when task.status === "done"', () => {
    const container = makeEl();
    const renderer = new ProjectDetailRenderer(new App(), new Component());
    const tasks = [
      makeTask({ id: 't-1', title: 'Alpha', status: 'todo' }),
      makeTask({ id: 't-2', title: 'Beta', status: 'done' })
    ];

    renderer.render(container as unknown as HTMLElement, makeCallbacks({ getTasks: () => tasks }));

    const rows = findAllByClassFragment(container, 'is-task');
    expect(rows).toHaveLength(2);
    // First row (alpha) does NOT have is-done.
    expect(rows[0].className.includes('is-done')).toBe(false);
    // Second row (beta) HAS is-done.
    expect(rows[1].className.includes('is-done')).toBe(true);
  });

  it('annotates each row with data-depth reflecting DFS depth', () => {
    const container = makeEl();
    const renderer = new ProjectDetailRenderer(new App(), new Component());
    const tasks = [
      makeTask({ id: 'parent', title: 'Parent', parentTaskId: undefined }),
      makeTask({ id: 'child', title: 'Child', parentTaskId: 'parent' }),
      makeTask({ id: 'grand', title: 'Grand', parentTaskId: 'child' })
    ];

    renderer.render(container as unknown as HTMLElement, makeCallbacks({ getTasks: () => tasks }));

    const rows = findAllByClassFragment(container, 'is-task');
    expect(rows).toHaveLength(3);
    expect(rows[0].attributes['data-depth']).toBe('0');
    expect(rows[1].attributes['data-depth']).toBe('1');
    expect(rows[2].attributes['data-depth']).toBe('2');
  });

  it('renders exactly 2 control buttons (Edit + Delete) per row — no checkbox', () => {
    const container = makeEl();
    const renderer = new ProjectDetailRenderer(new App(), new Component());
    const tasks = [makeTask({ id: 't-1', title: 'Alpha' })];

    renderer.render(container as unknown as HTMLElement, makeCallbacks({ getTasks: () => tasks }));

    const controls = findAllByClassFragment(container, 'setting-item-control');
    expect(controls).toHaveLength(1);

    // Each control should have exactly 2 <button> children.
    const buttons = findAllByTag(controls[0], 'BUTTON');
    expect(buttons).toHaveLength(2);

    // Aria labels confirm semantics — Edit + Delete, NOT a checkbox.
    const ariaLabels = buttons.map(b => b.attributes['aria-label']);
    expect(ariaLabels).toContain('Edit task');
    expect(ariaLabels).toContain('Delete task');

    // Negative: no input[type=checkbox] anywhere in the row.
    const inputs = findAllByTag(controls[0], 'INPUT');
    expect(inputs).toHaveLength(0);
  });

  it('emits priority dot + status text inside .task-meta-item', () => {
    const container = makeEl();
    const renderer = new ProjectDetailRenderer(new App(), new Component());
    const tasks = [makeTask({ id: 't-1', title: 'Alpha', priority: 'high', status: 'in_progress' })];

    renderer.render(container as unknown as HTMLElement, makeCallbacks({ getTasks: () => tasks }));

    const dots = findAllByClassFragment(container, 'task-meta-dot');
    expect(dots).toHaveLength(1);
    expect(dots[0].className).toContain('is-high');

    // Status text reflects formatStatus output ("In progress").
    const statusSpans = findAllByTag(container, 'SPAN').filter(s => s.textContent === 'In progress');
    expect(statusSpans.length).toBeGreaterThanOrEqual(1);
  });

  it('renders due-date span only when task.dueDate present; flags overdue for non-done', () => {
    const container = makeEl();
    const renderer = new ProjectDetailRenderer(new App(), new Component());
    const past = Date.now() - 24 * 60 * 60 * 1000;
    const tasks = [
      makeTask({ id: 't-overdue', title: 'Overdue', status: 'todo', dueDate: past }),
      makeTask({ id: 't-no-due', title: 'NoDue' })
    ];

    renderer.render(container as unknown as HTMLElement, makeCallbacks({ getTasks: () => tasks }));

    const overdueSpans = findAllByClassFragment(container, 'is-overdue');
    expect(overdueSpans).toHaveLength(1);
    expect(overdueSpans[0].textContent).toMatch(/^Due /);
  });

  it('renders assignee span only when task.assignee present', () => {
    const container = makeEl();
    const renderer = new ProjectDetailRenderer(new App(), new Component());
    const tasks = [
      makeTask({ id: 't-1', title: 'A', assignee: 'alice' }),
      makeTask({ id: 't-2', title: 'B' })
    ];

    renderer.render(container as unknown as HTMLElement, makeCallbacks({ getTasks: () => tasks }));

    const assigneeSpans = findAllByTag(container, 'SPAN').filter(s => s.textContent === '@alice');
    expect(assigneeSpans).toHaveLength(1);
  });
});
