/**
 * Delete-icon danger-class regression (PR4 polish fix).
 *
 * BUG (user-reported during PR4 smoke, pre-existing from PR2): the Projects-list
 * project-row delete button AND the project-detail task-row delete button used
 * `clickable-icon mod-warning`. Obsidian's `mod-warning` paints a filled-red
 * square that swamps the trash glyph, so both rendered as a solid red square.
 *
 * FIX: both icon buttons use `clickable-icon nexus-icon-danger` instead — a
 * transparent clickable-icon whose glyph turns red on hover (mirrors the
 * working StatesSectionRenderer delete idiom; CSS at styles.css `.clickable-icon
 * .nexus-icon-danger`).
 *
 * These assertions lock the fix in: each delete button must carry
 * `nexus-icon-danger` and must NOT carry `mod-warning`. They prevent the
 * red-square regression from returning at either site.
 *
 * Uses the local _children-tracking MockContainer pattern (mirrors
 * ProjectDetailRenderer.test.ts / WorkspaceContextConsolidation.test.ts).
 */

import { App, Component } from 'obsidian';
import { WorkspaceDetailRenderer, DetailCallbacks } from '../../src/components/workspace/WorkspaceDetailRenderer';
import { ProjectDetailRenderer, ProjectDetailEditorState, ProjectDetailCallbacks } from '../../src/components/workspace/ProjectDetailRenderer';
import type { ProjectMetadata } from '../../src/database/repositories/interfaces/IProjectRepository';
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

function findButtonByAriaLabel(root: MockEl, label: string): MockEl | undefined {
  let found: MockEl | undefined;
  const visit = (el: MockEl) => {
    if (el.tagName === 'BUTTON' && el.attributes['aria-label'] === label) {
      found = el;
    }
    el._children.forEach(visit);
  };
  root._children.forEach(visit);
  return found;
}

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------
function makeProject(over: Partial<ProjectMetadata> = {}): ProjectMetadata {
  return {
    id: 'p-1',
    workspaceId: 'ws-1',
    name: 'Project one',
    description: '',
    status: 'active',
    created: 1_700_000_000_000,
    updated: 1_700_000_000_000,
    ...over
  } as ProjectMetadata;
}

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

function makeDetailCallbacks(over: Partial<DetailCallbacks> = {}): DetailCallbacks {
  return {
    onNavigateList: jest.fn(),
    onNavigateDetail: jest.fn(),
    onNavigateProjects: jest.fn(),
    onNavigateProjectDetail: jest.fn(),
    onSaveWorkspace: jest.fn().mockResolvedValue(null),
    onDeleteWorkspace: jest.fn().mockResolvedValue(undefined),
    onOpenWorkflowEditor: jest.fn(),
    onRunWorkflow: jest.fn(),
    onOpenFilePicker: jest.fn(),
    onRefreshDetail: jest.fn(),
    getAvailableAgents: () => [],
    getTaskService: jest.fn().mockResolvedValue(null),
    onRefreshProjects: jest.fn().mockResolvedValue(undefined),
    onOpenProjectDetail: jest.fn(),
    onToggleProjectArchive: jest.fn().mockResolvedValue(undefined),
    safeRegisterDomEvent: jest.fn(),
    getStatesService: jest.fn().mockResolvedValue(null),
    getApp: () => new App(),
    ...over
  } as DetailCallbacks;
}

function makeProjectDetailCallbacks(over: Partial<ProjectDetailCallbacks> = {}): ProjectDetailCallbacks {
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

describe('Delete-icon danger class — red-square regression guard', () => {
  it('project-row delete button uses nexus-icon-danger, not mod-warning', () => {
    const container = makeEl();
    const renderer = new WorkspaceDetailRenderer(new Component());

    renderer.renderProjects(
      container as unknown as HTMLElement,
      { id: 'ws-1', name: 'Workspace' },
      [makeProject()],
      [],
      makeDetailCallbacks()
    );

    const deleteBtn = findButtonByAriaLabel(container, 'Delete project');
    expect(deleteBtn).toBeDefined();
    expect(deleteBtn!.className).toContain('clickable-icon');
    expect(deleteBtn!.className).toContain('nexus-icon-danger');
    expect(deleteBtn!.className).not.toContain('mod-warning');
  });

  it('task-row delete button uses nexus-icon-danger, not mod-warning', () => {
    const container = makeEl();
    const renderer = new ProjectDetailRenderer(new App(), new Component());

    renderer.render(
      container as unknown as HTMLElement,
      makeProjectDetailCallbacks({ getTasks: () => [makeTask()] })
    );

    const deleteBtn = findButtonByAriaLabel(container, 'Delete task');
    expect(deleteBtn).toBeDefined();
    expect(deleteBtn!.className).toContain('clickable-icon');
    expect(deleteBtn!.className).toContain('nexus-icon-danger');
    expect(deleteBtn!.className).not.toContain('mod-warning');
  });
});
