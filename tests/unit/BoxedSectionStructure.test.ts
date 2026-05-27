/**
 * BoxedSection Structural Deepening Tests
 *
 * Complements tests/unit/BoxedSection.test.ts (smoke coverage frontend-coder
 * shipped) by asserting:
 *   1. DOM nesting: action button lives inside the toolbar div (not loose
 *      in header), and the toolbar lives inside the header.
 *   2. No inline style.position / style.maxHeight on any element — sticky
 *      positioning and the 320px max-height must come from styles.css per
 *      the project's "no inline styles" non-negotiable in CLAUDE.md.
 *   3. getBody() / getElement() return stable references across calls.
 *   4. Late-render re-use pattern (caller .empty() + repopulate) doesn't
 *      disturb the BoxedSection's body reference.
 *
 * Uses the same _children-tracking mock pattern frontend-coder established
 * in BoxedSection.test.ts so structural assertions are observable.
 */

import { BoxedSection } from '../../src/settings/components/BoxedSection';
import { Component } from 'obsidian';

type MockElement = {
  tagName: string;
  className: string;
  id: string;
  style: Record<string, string>;
  createEl: jest.Mock<MockElement, [string, unknown?]>;
  createDiv: jest.Mock<MockElement, [string | { cls?: string }?]>;
  createSpan: jest.Mock<MockElement, [{ cls?: string; text?: string }?]>;
  addClass: jest.Mock<void, [string]>;
  setAttribute: jest.Mock<void, [string, string]>;
  addEventListener: jest.Mock<void, [string, () => void]>;
  empty: jest.Mock<void, []>;
  remove: jest.Mock<void, []>;
  textContent: string;
  _children: MockElement[];
};

function createMockContainer(): MockElement {
  const createElement = (cls?: string): MockElement => {
    const el: MockElement = {
      tagName: 'DIV',
      className: cls || '',
      id: '',
      style: {},
      addClass: jest.fn(),
      setAttribute: jest.fn(),
      createEl: jest.fn((tag?: string, opts?: { cls?: string; text?: string; attr?: Record<string, string> }) => {
        const child = createElement(opts?.cls || '');
        child.tagName = (tag || 'DIV').toUpperCase();
        if (opts?.text) child.textContent = opts.text;
        el._children.push(child);
        return child;
      }),
      createDiv: jest.fn((cls2?: string | { cls?: string }) => {
        const c = typeof cls2 === 'string' ? cls2 : cls2?.cls || '';
        const child = createElement(c);
        el._children.push(child);
        return child;
      }),
      createSpan: jest.fn((opts?: { cls?: string; text?: string }) => {
        const child = createElement(opts?.cls || '');
        if (opts?.text) child.textContent = opts.text;
        el._children.push(child);
        return child;
      }),
      addEventListener: jest.fn(),
      empty: jest.fn(),
      remove: jest.fn(),
      textContent: '',
      _children: [],
    };
    return el;
  };
  return createElement('');
}

function firstChild(el: MockElement): MockElement {
  const child = el._children[0];
  if (!child) throw new Error('Expected child not found');
  return child;
}

describe('BoxedSection structural deepening', () => {
  describe('Toolbar / action nesting (header.toolbar.action, not header.action)', () => {
    it('places .ws-section-toolbar as a child of .ws-section-header (not of <section>)', () => {
      const container = createMockContainer();
      new BoxedSection(container as unknown as HTMLElement, {
        title: 'T',
        toolbar: (tb) => { tb.createSpan({ text: 'tb' }); },
        body: () => { void 0; }
      });

      const section = firstChild(container);
      // section._children = [header, body]; toolbar must NOT appear here.
      const headerIdx = section._children.findIndex(c => c.className === 'ws-section-header');
      const bodyIdx = section._children.findIndex(c => c.className === 'ws-section-body');
      const toolbarAtSectionLevel = section._children.find(c => c.className === 'ws-section-toolbar');
      expect(headerIdx).toBeGreaterThanOrEqual(0);
      expect(bodyIdx).toBeGreaterThanOrEqual(0);
      expect(toolbarAtSectionLevel).toBeUndefined();

      const header = section._children[headerIdx];
      const toolbar = header._children.find(c => c.className === 'ws-section-toolbar');
      expect(toolbar).toBeDefined();
    });

    it('places .ws-section-action button as a child of .ws-section-toolbar (not of header)', () => {
      const container = createMockContainer();
      new BoxedSection(container as unknown as HTMLElement, {
        title: 'T',
        actionLabel: '+ New thing',
        onAction: () => { void 0; },
        body: () => { void 0; }
      });

      const section = firstChild(container);
      const header = section._children.find(c => c.className === 'ws-section-header');
      const toolbar = header?._children.find(c => c.className === 'ws-section-toolbar');
      expect(toolbar).toBeDefined();

      // Header should NOT have a direct action button child — must be under toolbar.
      const actionAtHeaderLevel = header?._children.find(c => c.className === 'ws-section-action');
      expect(actionAtHeaderLevel).toBeUndefined();

      const action = toolbar?._children.find(c => c.className === 'ws-section-action');
      expect(action).toBeDefined();
      expect(action?.tagName).toBe('BUTTON');
      expect(action?.textContent).toBe('+ New thing');
    });

    it('does NOT create a toolbar when neither toolbar callback nor action are set', () => {
      const container = createMockContainer();
      new BoxedSection(container as unknown as HTMLElement, {
        title: 'T',
        body: () => { void 0; }
      });

      const section = firstChild(container);
      const header = section._children.find(c => c.className === 'ws-section-header');
      const toolbar = header?._children.find(c => c.className === 'ws-section-toolbar');
      expect(toolbar).toBeUndefined();
    });

    it('creates the toolbar even with toolbar-only (no action)', () => {
      const container = createMockContainer();
      new BoxedSection(container as unknown as HTMLElement, {
        title: 'T',
        toolbar: (tb) => { tb.createSpan({ text: 'just-toolbar' }); },
        body: () => { void 0; }
      });

      const section = firstChild(container);
      const header = section._children.find(c => c.className === 'ws-section-header');
      const toolbar = header?._children.find(c => c.className === 'ws-section-toolbar');
      expect(toolbar).toBeDefined();
      // No action button created
      const action = toolbar?._children.find(c => c.className === 'ws-section-action');
      expect(action).toBeUndefined();
    });
  });

  describe('No inline style leakage (CLAUDE.md non-negotiable)', () => {
    it('does NOT touch section.style (sticky positioning comes from styles.css)', () => {
      const container = createMockContainer();
      new BoxedSection(container as unknown as HTMLElement, {
        title: 'T',
        actionLabel: 'X',
        onAction: () => { void 0; },
        body: (b) => { b.createDiv('content'); }
      });

      const section = firstChild(container);
      // style object must remain empty — no inline mutations
      expect(Object.keys(section.style)).toHaveLength(0);
    });

    it('does NOT touch header.style', () => {
      const container = createMockContainer();
      new BoxedSection(container as unknown as HTMLElement, {
        title: 'T',
        body: () => { void 0; }
      });

      const section = firstChild(container);
      const header = section._children.find(c => c.className === 'ws-section-header');
      expect(Object.keys(header?.style ?? {})).toHaveLength(0);
    });

    it('does NOT touch body.style (max-height comes from styles.css)', () => {
      const container = createMockContainer();
      new BoxedSection(container as unknown as HTMLElement, {
        title: 'T',
        unbounded: true,
        body: () => { void 0; }
      });

      const section = firstChild(container);
      const body = section._children.find(c => c.className === 'ws-section-body');
      expect(Object.keys(body?.style ?? {})).toHaveLength(0);
    });
  });

  describe('getBody() / getElement() identity stability', () => {
    it('getBody() returns the same reference across multiple calls', () => {
      const container = createMockContainer();
      const section = new BoxedSection(container as unknown as HTMLElement, {
        title: 'T',
        body: () => { void 0; }
      });

      const a = section.getBody();
      const b = section.getBody();
      const c = section.getBody();

      expect(a).toBe(b);
      expect(b).toBe(c);
    });

    it('getElement() returns the same reference across multiple calls', () => {
      const container = createMockContainer();
      const section = new BoxedSection(container as unknown as HTMLElement, {
        title: 'T',
        body: () => { void 0; }
      });

      expect(section.getElement()).toBe(section.getElement());
    });

    it('getBody() returns the same element passed to the body callback', () => {
      const container = createMockContainer();
      let bodyFromCallback: HTMLElement | undefined;
      const section = new BoxedSection(container as unknown as HTMLElement, {
        title: 'T',
        body: (b) => { bodyFromCallback = b; }
      });

      expect(section.getBody()).toBe(bodyFromCallback);
    });

    it('getElement() returns the section element appended to the container', () => {
      const container = createMockContainer();
      const section = new BoxedSection(container as unknown as HTMLElement, {
        title: 'T',
        body: () => { void 0; }
      });

      expect(section.getElement()).toBe(container._children[0]);
    });
  });

  describe('Late-render pattern (getBody().empty() + repopulate)', () => {
    it('does not invalidate the body reference after caller invokes .empty()', () => {
      const container = createMockContainer();
      const section = new BoxedSection(container as unknown as HTMLElement, {
        title: 'T',
        body: (b) => { b.createDiv('first-render'); }
      });

      const bodyBefore = section.getBody();
      bodyBefore.empty();
      // Caller pattern: re-populate after empty
      (bodyBefore as unknown as MockElement).createDiv('second-render');

      const bodyAfter = section.getBody();
      expect(bodyAfter).toBe(bodyBefore);
      // .empty was invoked on the same node
      expect((bodyBefore as unknown as MockElement).empty).toHaveBeenCalledTimes(1);
    });
  });

  describe('Component-scoped event registration target', () => {
    it('wires the action button click via component.registerDomEvent (not addEventListener) when component provided', () => {
      const container = createMockContainer();
      const component = new Component();
      const registerSpy = jest.spyOn(component, 'registerDomEvent');
      const handler = jest.fn();

      new BoxedSection(container as unknown as HTMLElement, {
        title: 'T',
        actionLabel: 'Go',
        onAction: handler,
        body: () => { void 0; }
      }, component);

      expect(registerSpy).toHaveBeenCalledTimes(1);
      const [el, type] = registerSpy.mock.calls[0];
      expect(type).toBe('click');
      // The element passed in MUST be the action button (className ws-section-action).
      expect((el as unknown as MockElement).className).toBe('ws-section-action');
      expect((el as unknown as MockElement).tagName).toBe('BUTTON');
      // NOTE: The Obsidian mock's registerDomEvent internally calls
      // el.addEventListener for cleanup tracking. The contract we're testing
      // is "BoxedSection routes through component.registerDomEvent" — verified
      // above. Direct el.addEventListener calls are an implementation detail
      // of the mock, not BoxedSection itself.
    });

    it('falls back to addEventListener when NO component provided', () => {
      const container = createMockContainer();
      const handler = jest.fn();

      new BoxedSection(container as unknown as HTMLElement, {
        title: 'T',
        actionLabel: 'Go',
        onAction: handler,
        body: () => { void 0; }
      });

      const section = firstChild(container);
      const header = section._children.find(c => c.className === 'ws-section-header');
      const toolbar = header?._children.find(c => c.className === 'ws-section-toolbar');
      const action = toolbar?._children.find(c => c.className === 'ws-section-action');
      expect(action?.addEventListener).toHaveBeenCalledTimes(1);
      const [type] = (action?.addEventListener as jest.Mock).mock.calls[0];
      expect(type).toBe('click');
    });
  });
});
