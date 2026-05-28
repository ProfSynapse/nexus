/**
 * Wave 3 PR2 Commit 5 — UAT polish characterization tests.
 *
 * Covers two of the three Commit 5 items:
 *   ITEM 1 — project-archiving UI removed from WorkspaceDetailRenderer.renderProjects:
 *     no "Show archived" toggle, no "Archived" group label, no per-row
 *     "Archive project" button. The onToggleProjectArchive callback is retained
 *     on the interface (MCP/AI backend) but never invoked from the UI.
 *   ITEM 3 — Context section consolidation in WorkspaceFormRenderer:
 *     the dedicated-agent dropdown + key-files editors moved INTO the "Context"
 *     BoxedSection; the standalone "Agent & files" section no longer renders.
 *
 * Uses the local _children-tracking MockContainer pattern (mirrors
 * tests/unit/ProjectDetailRenderer.test.ts) — the project does not use jsdom
 * for DOM-tree assertions.
 */

import { App, Component } from 'obsidian';
import { WorkspaceFormRenderer } from '../../src/components/workspace/WorkspaceFormRenderer';
import { WorkspaceDetailRenderer, DetailCallbacks } from '../../src/components/workspace/WorkspaceDetailRenderer';
import type { ProjectWorkspace } from '../../src/database/workspace-types';
import type { ProjectMetadata } from '../../src/database/repositories/interfaces/IProjectRepository';

// ----------------------------------------------------------------------------
// Local MockContainer w/ _children + text/cls tracking
// ----------------------------------------------------------------------------
type MockEl = {
  tagName: string;
  className: string;
  attributes: Record<string, string>;
  createEl: jest.Mock<MockEl, [string, unknown?]>;
  createDiv: jest.Mock<MockEl, [unknown?]>;
  createSpan: jest.Mock<MockEl, [unknown?]>;
  addClass: jest.Mock<void, [string]>;
  removeClass: jest.Mock<void, [string]>;
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
    removeClass: jest.fn(),
    setAttribute: jest.fn((k: string, v: string) => { el.attributes[k] = v; }),
    empty: jest.fn(() => { el._children.length = 0; }),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    textContent: '',
    _children: []
  };
  return el;
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

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------
function makeFormData(over: Partial<ProjectWorkspace> = {}): Partial<ProjectWorkspace> {
  return {
    id: 'ws-1',
    name: 'Test workspace',
    description: '',
    rootFolder: '/',
    context: {
      purpose: 'do things',
      workflows: [],
      keyFiles: ['notes/index.md'],
      preferences: ''
    },
    ...over
  } as Partial<ProjectWorkspace>;
}

function makeProject(over: Partial<ProjectMetadata> = {}): ProjectMetadata {
  return {
    id: 'p-1',
    workspaceId: 'ws-1',
    name: 'Project one',
    status: 'active',
    created: 1_700_000_000_000,
    updated: 1_700_000_000_000,
    ...over
  } as ProjectMetadata;
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
  };
}

describe('Wave 3 PR2 Commit 5 — Context consolidation + archiving-UI removal', () => {
  describe('ITEM 3 — Context section consolidation (WorkspaceFormRenderer)', () => {
    it('renders a "Context" section and NO standalone "Agent & files" section', () => {
      const container = makeEl();
      const renderer = new WorkspaceFormRenderer(
        makeFormData(),
        [],
        () => undefined, () => undefined, () => undefined, () => undefined,
        new Component(),
        new App()
      );

      renderer.render(container as unknown as HTMLElement);

      const titles = findAllByClassFragment(container, 'ws-section-title').map(e => e.textContent);
      expect(titles).toContain('Context');
      expect(titles).not.toContain('Agent & files');
    });

    it('places the Dedicated agent + Key files labels inside the Context section body', () => {
      const container = makeEl();
      const renderer = new WorkspaceFormRenderer(
        makeFormData(),
        [],
        () => undefined, () => undefined, () => undefined, () => undefined,
        new Component(),
        new App()
      );

      renderer.render(container as unknown as HTMLElement);

      // Find the Context section element, then assert its subtree text.
      const sections = findAllByClassFragment(container, 'ws-section');
      const contextSection = sections.find(s =>
        collectText(s).includes('Context')
      );
      expect(contextSection).toBeDefined();

      const sectionText = collectText(contextSection!);
      expect(sectionText).toContain('Dedicated agent');
      expect(sectionText).toContain('Key files');
      expect(sectionText).toContain('Purpose');
      expect(sectionText).toContain('Preferences');
      // Commit 6: Workflows is extracted to its own section — NOT inside Context.
      expect(sectionText).not.toContain('Workflows');
    });

    it('preserves dedicatedAgentId binding — agent dropdown reads the top-level field', () => {
      const container = makeEl();
      const agents = [{ id: 'agent-1', name: 'Researcher' }] as never[];
      const formData = makeFormData({ dedicatedAgentId: 'agent-1' } as Partial<ProjectWorkspace>);
      const renderer = new WorkspaceFormRenderer(
        formData,
        agents,
        () => undefined, () => undefined, () => undefined, () => undefined,
        new Component(),
        new App()
      );

      // Rendering must not throw and must surface the agent label; the binding
      // itself is exercised by the dropdown onChange covered elsewhere. This
      // asserts the consolidated section still wires the agent editor.
      expect(() => renderer.render(container as unknown as HTMLElement)).not.toThrow();
      const sectionText = collectText(container);
      expect(sectionText).toContain('Dedicated agent');
    });
  });

  describe('Commit 6 — Workflows extracted to its own top-level section (WorkspaceFormRenderer)', () => {
    it('renders a standalone "Workflows" boxed section separate from "Context"', () => {
      const container = makeEl();
      const renderer = new WorkspaceFormRenderer(
        makeFormData(),
        [],
        () => undefined, () => undefined, () => undefined, () => undefined,
        new Component(),
        new App()
      );

      renderer.render(container as unknown as HTMLElement);

      const titles = findAllByClassFragment(container, 'ws-section-title').map(e => e.textContent);
      expect(titles).toContain('Context');
      expect(titles).toContain('Workflows');

      // The Workflows section is a distinct boxed section, not the Context one.
      const sections = findAllByClassFragment(container, 'ws-section');
      const workflowsSection = sections.find(s =>
        findAllByClassFragment(s, 'ws-section-title').some(t => t.textContent === 'Workflows')
      );
      const contextSection = sections.find(s =>
        findAllByClassFragment(s, 'ws-section-title').some(t => t.textContent === 'Context')
      );
      expect(workflowsSection).toBeDefined();
      expect(contextSection).toBeDefined();
      expect(workflowsSection).not.toBe(contextSection);
    });

    it('renders the empty-state ("None") inside the Workflows section body', () => {
      // Button labels (e.g. "Add workflow") are set via ButtonComponent and are
      // not surfaced into the mock DOM textContent, so we assert the empty-state
      // span — which IS createEl('span', {text}) — to prove the workflow list
      // body renders inside the extracted section.
      const container = makeEl();
      const renderer = new WorkspaceFormRenderer(
        makeFormData(),
        [],
        () => undefined, () => undefined, () => undefined, () => undefined,
        new Component(),
        new App()
      );

      renderer.render(container as unknown as HTMLElement);

      const sections = findAllByClassFragment(container, 'ws-section');
      const workflowsSection = sections.find(s =>
        findAllByClassFragment(s, 'ws-section-title').some(t => t.textContent === 'Workflows')
      );
      expect(workflowsSection).toBeDefined();

      const sectionText = collectText(workflowsSection!);
      expect(sectionText).toContain('None');
    });
  });

  describe('ITEM 1 — project-archiving UI removed (WorkspaceDetailRenderer.renderProjects)', () => {
    function renderProjects(projects: ProjectMetadata[], callbacks?: Partial<DetailCallbacks>): MockEl {
      const container = makeEl();
      const renderer = new WorkspaceDetailRenderer(new Component());
      renderer.renderProjects(
        container as unknown as HTMLElement,
        { id: 'ws-1', name: 'WS' },
        projects,
        [],
        makeDetailCallbacks(callbacks)
      );
      return container;
    }

    it('renders NO "Show archived" toggle in the Projects section', () => {
      const container = renderProjects([makeProject()]);
      const text = collectText(container);
      expect(text).not.toContain('Show archived');
    });

    it('renders NO "Archived" group label (Active/Completed only)', () => {
      const container = renderProjects([
        makeProject({ id: 'a', name: 'Active one', status: 'active' }),
        makeProject({ id: 'c', name: 'Done one', status: 'completed' }),
        makeProject({ id: 'z', name: 'Old one', status: 'archived' })
      ]);
      const groupLabels = findAllByClassFragment(container, 'ws-group-label').map(e => e.textContent);
      expect(groupLabels.some(l => l.startsWith('Active'))).toBe(true);
      expect(groupLabels.some(l => l.startsWith('Completed'))).toBe(true);
      expect(groupLabels.some(l => l.startsWith('Archived'))).toBe(false);
    });

    it('does NOT render archived projects at all (archived bucket dropped)', () => {
      const container = renderProjects([
        makeProject({ id: 'a', name: 'Visible active', status: 'active' }),
        makeProject({ id: 'z', name: 'Hidden archived', status: 'archived' })
      ]);
      const text = collectText(container);
      expect(text).toContain('Visible active');
      expect(text).not.toContain('Hidden archived');
    });

    it('renders NO per-row "Archive project" button and never invokes onToggleProjectArchive', () => {
      const onToggleProjectArchive = jest.fn().mockResolvedValue(undefined);
      const container = renderProjects([makeProject()], { onToggleProjectArchive });

      // No button carries the archive/restore aria-label.
      expect(findByAttr(container, 'aria-label', 'Archive project')).toHaveLength(0);
      expect(findByAttr(container, 'aria-label', 'Restore project')).toHaveLength(0);
      // Edit + Delete affordances remain.
      expect(findByAttr(container, 'aria-label', 'Edit project').length).toBeGreaterThan(0);
      expect(findByAttr(container, 'aria-label', 'Delete project').length).toBeGreaterThan(0);
      // The backend callback is never called from the projects UI.
      expect(onToggleProjectArchive).not.toHaveBeenCalled();
    });
  });
});
