/**
 * WorkflowEditorRenderer Tests (Wave 3 PR4)
 *
 * PR4 ported the workflow editor onto the shared BoxedSection primitive:
 *   - Identity / Prompt / Steps / Schedule each wrapped in `new BoxedSection`
 *     (4 sections, unbounded), per the v3.1 mockup (the authoritative visual
 *     contract — team-lead confirmed the 4-section split is blessed).
 *   - The required 5th ctor param `component: Component` is threaded into
 *     EVERY BoxedSection construction (BoxedSection needs it for
 *     registerDomEvent-based cleanup).
 *   - The Schedule "Enabled" toggle moved into the section header toolbar; its
 *     handler still empties+rebuilds the schedule fields div in place — this is
 *     the one piece of stateful behavior carried verbatim through the port and
 *     the highest behavior-change surface in this PR.
 *
 * Test strategy: jest.mock the BoxedSection module with a spy-class that records
 * (container, config, component) per construction and synchronously invokes the
 * toolbar/body callbacks against a children-tracking mock element. This lets us
 * assert the 4-section contract + the component threading + the schedule
 * re-render side-effect without a real DOM (the project runs jest in a
 * jsdom-less `node` testEnvironment — see prior Wave-3 test memories).
 */

import type { BoxedSectionConfig } from '../../src/settings/components/BoxedSection';

// ============================================================================
// BoxedSection spy-class mock — records every construction.
// ============================================================================

interface RecordedSection {
  container: unknown;
  config: BoxedSectionConfig;
  component: unknown;
  bodyEl: MockElement;
  toolbarEl?: MockElement;
}

const recordedSections: RecordedSection[] = [];

jest.mock('../../src/settings/components/BoxedSection', () => {
  return {
    BoxedSection: class {
      private bodyEl: MockElement;
      constructor(container: unknown, config: BoxedSectionConfig, component: unknown) {
        const bodyEl = createMockEl('ws-section-body');
        const record: RecordedSection = { container, config, component, bodyEl };
        // Invoke toolbar callback (if any) against a fresh toolbar element so
        // production toolbar wiring (the Schedule Enabled toggle) executes.
        if (config.toolbar) {
          const toolbarEl = createMockEl('ws-section-toolbar');
          record.toolbarEl = toolbarEl;
          config.toolbar(toolbarEl as unknown as HTMLElement);
        }
        // Invoke the body callback against a body element so the schedule
        // fields div is created and renderScheduleFields runs once.
        config.body(bodyEl as unknown as HTMLElement);
        this.bodyEl = bodyEl;
        recordedSections.push(record);
      }
      getBody(): unknown { return this.bodyEl; }
      getElement(): unknown { return createMockEl('ws-section'); }
    }
  };
});

import { WorkflowEditorRenderer, Workflow } from '../../src/components/workspace/WorkflowEditorRenderer';
import { Component } from 'obsidian';

// ============================================================================
// Children-tracking mock element (richer than core.ts createMockElement —
// tracks _children, dataset, and captured registerDomEvent handlers).
// ============================================================================

type MockEl = MockElement;

interface MockElement {
  tagName: string;
  className: string;
  id: string;
  type?: string;
  checked?: boolean;
  rows?: number;
  textContent: string;
  dataset: Record<string, string>;
  _children: MockElement[];
  _attrs: Record<string, string>;
  createEl: jest.Mock;
  createDiv: jest.Mock;
  createSpan: jest.Mock;
  addClass: jest.Mock;
  removeClass: jest.Mock;
  setAttribute: jest.Mock;
  addEventListener: jest.Mock;
  empty: jest.Mock;
  remove: jest.Mock;
  inputEl?: MockElement;
}

function createMockEl(cls = ''): MockElement {
  const el: MockElement = {
    tagName: 'DIV',
    className: cls,
    id: '',
    textContent: '',
    dataset: {},
    _children: [],
    _attrs: {},
    addClass: jest.fn(),
    removeClass: jest.fn(),
    setAttribute: jest.fn((k: string, v: string) => { el._attrs[k] = v; }),
    addEventListener: jest.fn(),
    empty: jest.fn(() => { el._children = []; }),
    remove: jest.fn(),
    createEl: jest.fn((tag?: string, opts?: { cls?: string; text?: string; type?: string; attr?: Record<string, string> }) => {
      const child = createMockEl(opts?.cls || '');
      child.tagName = (tag || 'DIV').toUpperCase();
      if (opts?.text) child.textContent = opts.text;
      if (opts?.type) child.type = opts.type;
      if (opts?.attr) Object.assign(child._attrs, opts.attr);
      el._children.push(child);
      return child;
    }),
    createDiv: jest.fn((arg?: string | { cls?: string }) => {
      const c = typeof arg === 'string' ? arg : arg?.cls || '';
      const child = createMockEl(c);
      el._children.push(child);
      return child;
    }),
    createSpan: jest.fn((opts?: { cls?: string; text?: string }) => {
      const child = createMockEl(opts?.cls || '');
      if (opts?.text) child.textContent = opts.text;
      el._children.push(child);
      return child;
    }),
  };
  return el;
}

// ============================================================================
// Helpers
// ============================================================================

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    name: 'Weekly planning',
    when: 'Plan next week',
    steps: 'Research, outline, draft',
    ...overrides
  };
}

/**
 * Build a renderer with a Component whose registerDomEvent is spied. The spy
 * is attached BEFORE render() so we can read .mock.calls afterward to recover
 * the schedule-toggle change handler (Component.registerDomEvent is a real
 * method on the mock, not a jest.fn by default).
 */
function makeSpiedComponent(): Component {
  const component = new Component();
  jest.spyOn(component, 'registerDomEvent');
  return component;
}

function renderEditor(workflow: Workflow, isNew = false): {
  component: Component;
  onSave: jest.Mock;
  onCancel: jest.Mock;
  onRunNow: jest.Mock;
  container: MockElement;
} {
  const component = makeSpiedComponent();
  const onSave = jest.fn();
  const onCancel = jest.fn();
  const onRunNow = jest.fn();
  const renderer = new WorkflowEditorRenderer([], onSave, onCancel, onRunNow, component);
  const container = createMockEl('root');
  renderer.render(container as unknown as HTMLElement, workflow, isNew);
  return { component, onSave, onCancel, onRunNow, container };
}

function sectionByTitle(title: string): RecordedSection {
  const found = recordedSections.find(s => s.config.title === title);
  if (!found) throw new Error(`No BoxedSection rendered with title "${title}". Got: ${recordedSections.map(s => s.config.title).join(', ')}`);
  return found;
}

// ============================================================================
// Tests
// ============================================================================

describe('WorkflowEditorRenderer (PR4 BoxedSection port)', () => {
  beforeEach(() => {
    recordedSections.length = 0;
  });

  describe('section structure — exactly 4 BoxedSections', () => {
    it('renders exactly 4 BoxedSections', () => {
      renderEditor(makeWorkflow());
      expect(recordedSections).toHaveLength(4);
    });

    it('renders Identity, Prompt, Steps, Schedule in that order', () => {
      renderEditor(makeWorkflow());
      const titles = recordedSections.map(s => s.config.title);
      expect(titles).toEqual(['Identity', 'Prompt', 'Steps', 'Schedule']);
    });

    it('marks every section unbounded (form sections own their own flow)', () => {
      renderEditor(makeWorkflow());
      for (const section of recordedSections) {
        expect(section.config.unbounded).toBe(true);
      }
    });

    it('assigns a stable titleId to each section (aria-labelledby anchor)', () => {
      renderEditor(makeWorkflow());
      expect(sectionByTitle('Identity').config.titleId).toBe('wf-id-h');
      expect(sectionByTitle('Prompt').config.titleId).toBe('wf-prompt-h');
      expect(sectionByTitle('Steps').config.titleId).toBe('wf-steps-h');
      expect(sectionByTitle('Schedule').config.titleId).toBe('wf-sched-h');
    });
  });

  describe('component threading (the required 5th ctor param)', () => {
    it('threads the same Component instance into all 4 BoxedSections', () => {
      const { component } = renderEditor(makeWorkflow());
      expect(recordedSections).toHaveLength(4);
      for (const section of recordedSections) {
        expect(section.component).toBe(component);
      }
    });

    it('never constructs a BoxedSection without a component', () => {
      renderEditor(makeWorkflow());
      for (const section of recordedSections) {
        expect(section.component).toBeInstanceOf(Component);
      }
    });
  });

  describe('Schedule section — Enabled toggle in the header toolbar', () => {
    it('renders the Enabled toggle in the toolbar (not the body)', () => {
      renderEditor(makeWorkflow());
      const schedule = sectionByTitle('Schedule');
      expect(schedule.config.toolbar).toBeDefined();
      // Toolbar created a .ws-section-toggle label containing the checkbox.
      const label = schedule.toolbarEl?._children.find(c => c.className === 'ws-section-toggle');
      expect(label).toBeDefined();
      const checkbox = label?._children.find(c => c.type === 'checkbox');
      expect(checkbox).toBeDefined();
    });

    it('reflects the workflow.schedule.enabled state on the toggle checkbox', () => {
      renderEditor(makeWorkflow({ schedule: { enabled: true, frequency: 'daily', hour: 9, minute: 0, catchUp: 'latest' } }));
      const schedule = sectionByTitle('Schedule');
      const label = schedule.toolbarEl?._children.find(c => c.className === 'ws-section-toggle');
      const checkbox = label?._children.find(c => c.type === 'checkbox');
      expect(checkbox?.checked).toBe(true);
    });

    it('toggle is unchecked when no schedule exists', () => {
      renderEditor(makeWorkflow({ schedule: undefined }));
      const schedule = sectionByTitle('Schedule');
      const label = schedule.toolbarEl?._children.find(c => c.className === 'ws-section-toggle');
      const checkbox = label?._children.find(c => c.type === 'checkbox');
      expect(checkbox?.checked).toBe(false);
    });

    it('registers the toggle change handler through component.registerDomEvent', () => {
      // Positive assertion only: the Obsidian Component mock's registerDomEvent
      // internally calls el.addEventListener for cleanup tracking, so a
      // negative "addEventListener was not called" assertion is unsatisfiable
      // (documented Wave-3 lesson). Assert the registration happened on the
      // checkbox with the 'change' event instead.
      const { component } = renderEditor(makeWorkflow());
      const calls = (component.registerDomEvent as unknown as jest.Mock).mock.calls;
      const changeReg = calls.find((c: unknown[]) => c[1] === 'change');
      expect(changeReg).toBeDefined();
      const checkbox = changeReg![0] as MockElement;
      expect(checkbox.type).toBe('checkbox');
    });
  });

  describe('Schedule conditional re-render (highest behavior-change surface)', () => {
    /**
     * The toggle handler is wired via component.registerDomEvent(checkbox,
     * 'change', handler). We capture that handler from the mocked Component,
     * flip the checkbox, invoke the handler, and assert the schedule-fields
     * div was emptied + rebuilt — the in-place re-render contract.
     */
    function captureToggleHandler(component: Component): { handler: () => void; checkbox: MockElement; fieldsDiv: MockElement } {
      const calls = (component.registerDomEvent as unknown as jest.Mock).mock.calls;
      // Find the change registration on the checkbox element.
      const reg = calls.find((c: unknown[]) => c[1] === 'change');
      if (!reg) throw new Error('No change handler registered on the schedule toggle');
      const checkbox = reg[0] as MockElement;
      const handler = reg[2] as () => void;
      // The schedule fields div is the first child created in the Schedule body.
      const schedule = sectionByTitle('Schedule');
      const fieldsDiv = schedule.bodyEl._children.find(c => c.className === 'nexus-workflow-schedule-fields');
      if (!fieldsDiv) throw new Error('schedule fields div not found in Schedule body');
      return { handler, checkbox, fieldsDiv };
    }

    it('captures the Enabled-toggle change handler through registerDomEvent', () => {
      const { component } = renderEditor(makeWorkflow({ schedule: undefined }));
      const { handler } = captureToggleHandler(component);
      expect(typeof handler).toBe('function');
    });

    it('re-renders the schedule fields div (empty+rebuild) when toggled ON', () => {
      const { component } = renderEditor(makeWorkflow({ schedule: undefined }));
      const { handler, checkbox, fieldsDiv } = captureToggleHandler(component);
      const emptyCallsBefore = fieldsDiv.empty.mock.calls.length;

      checkbox.checked = true;
      handler();

      // renderScheduleFields(fieldsDiv) starts with container.empty().
      expect(fieldsDiv.empty.mock.calls.length).toBeGreaterThan(emptyCallsBefore);
    });

    it('builds the enabled schedule on the workflow when toggled ON', () => {
      const component = makeSpiedComponent();
      const renderer = new WorkflowEditorRenderer([], jest.fn(), jest.fn(), jest.fn(), component);
      const container = createMockEl('root');
      renderer.render(container as unknown as HTMLElement, makeWorkflow({ schedule: undefined }), false);

      expect(renderer.getWorkflow().schedule).toBeUndefined();

      const calls = (component.registerDomEvent as unknown as jest.Mock).mock.calls;
      const reg = calls.find((c: unknown[]) => c[1] === 'change');
      const checkbox = reg[0] as MockElement;
      const handler = reg[2] as () => void;

      checkbox.checked = true;
      handler();

      const wf = renderer.getWorkflow();
      expect(wf.schedule).toBeDefined();
      expect(wf.schedule?.enabled).toBe(true);
      // buildEnabledSchedule defaults to a daily schedule.
      expect(wf.schedule?.frequency).toBe('daily');
    });

    it('clears the workflow schedule when toggled OFF', () => {
      const component = makeSpiedComponent();
      const renderer = new WorkflowEditorRenderer([], jest.fn(), jest.fn(), jest.fn(), component);
      const container = createMockEl('root');
      renderer.render(
        container as unknown as HTMLElement,
        makeWorkflow({ schedule: { enabled: true, frequency: 'daily', hour: 9, minute: 0, catchUp: 'latest' } }),
        false
      );

      expect(renderer.getWorkflow().schedule?.enabled).toBe(true);

      const calls = (component.registerDomEvent as unknown as jest.Mock).mock.calls;
      const reg = calls.find((c: unknown[]) => c[1] === 'change');
      const checkbox = reg[0] as MockElement;
      const handler = reg[2] as () => void;

      checkbox.checked = false;
      handler();

      expect(renderer.getWorkflow().schedule).toBeUndefined();
    });
  });

  describe('validation', () => {
    it('getWorkflow returns a clone (mutating the returned object does not leak back)', () => {
      const renderer = new WorkflowEditorRenderer([], jest.fn(), jest.fn(), jest.fn(), new Component());
      const container = createMockEl('root');
      renderer.render(container as unknown as HTMLElement, makeWorkflow({ name: 'Original' }), false);
      const wf = renderer.getWorkflow();
      wf.name = 'Mutated';
      expect(renderer.getWorkflow().name).toBe('Original');
    });
  });
});
