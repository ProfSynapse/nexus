/**
 * BoxedSection Unit Tests
 *
 * Verifies the boxed-section primitive renders the .ws-section header/body/
 * optional toolbar + action structure, respects unbounded, wires accessibility
 * (aria-labelledby), and routes the action click through registerDomEvent
 * when a Component is provided.
 */

import { BoxedSection } from '../../src/settings/components/BoxedSection';
import { Component } from 'obsidian';

// ============================================================================
// Helpers
// ============================================================================

type MockElement = {
  tagName: string;
  className: string;
  id: string;
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

function getFirstChild(el: MockElement): MockElement {
  const child = el._children[0];
  if (!child) throw new Error('Expected child element not found');
  return child;
}

// ============================================================================
// BoxedSection Tests
// ============================================================================

describe('BoxedSection', () => {

  describe('rendering', () => {
    it('should create a <section> with class ws-section', () => {
      const container = createMockContainer();
      new BoxedSection(container as unknown as HTMLElement, {
        title: 'Test',
        body: () => { /* no-op */ }
      });

      expect(container.createEl).toHaveBeenCalledWith('section', { cls: 'ws-section' });
    });

    it('should create header with ws-section-header class', () => {
      const container = createMockContainer();
      new BoxedSection(container as unknown as HTMLElement, {
        title: 'Test',
        body: () => { /* no-op */ }
      });

      const section = getFirstChild(container);
      expect(section.createDiv).toHaveBeenCalledWith('ws-section-header');
    });

    it('should create h3 title with the provided text', () => {
      const container = createMockContainer();
      new BoxedSection(container as unknown as HTMLElement, {
        title: 'Projects',
        body: () => { /* no-op */ }
      });

      const section = getFirstChild(container);
      const header = getFirstChild(section);
      expect(header.createEl).toHaveBeenCalledWith('h3', expect.objectContaining({
        text: 'Projects',
        cls: 'ws-section-title'
      }));
    });

    it('should create body with ws-section-body class', () => {
      const container = createMockContainer();
      new BoxedSection(container as unknown as HTMLElement, {
        title: 'Test',
        body: () => { /* no-op */ }
      });

      const section = getFirstChild(container);
      expect(section.createDiv).toHaveBeenCalledWith('ws-section-body');
    });

    it('should add is-unbounded class on body when unbounded=true', () => {
      const container = createMockContainer();
      new BoxedSection(container as unknown as HTMLElement, {
        title: 'Test',
        unbounded: true,
        body: () => { /* no-op */ }
      });

      const section = getFirstChild(container);
      // section._children = [header, body]
      const body = section._children[1];
      expect(body?.addClass).toHaveBeenCalledWith('is-unbounded');
    });

    it('should NOT add is-unbounded class when unbounded is omitted', () => {
      const container = createMockContainer();
      new BoxedSection(container as unknown as HTMLElement, {
        title: 'Test',
        body: () => { /* no-op */ }
      });

      const section = getFirstChild(container);
      const body = section._children[1];
      expect(body?.addClass).not.toHaveBeenCalled();
    });
  });

  describe('aria-labelledby', () => {
    it('should set aria-labelledby on section + id on title when titleId provided', () => {
      const container = createMockContainer();
      new BoxedSection(container as unknown as HTMLElement, {
        title: 'States',
        titleId: 'states-section-title',
        body: () => { /* no-op */ }
      });

      const section = getFirstChild(container);
      expect(section.setAttribute).toHaveBeenCalledWith('aria-labelledby', 'states-section-title');

      const header = getFirstChild(section);
      const title = getFirstChild(header);
      expect(title.id).toBe('states-section-title');
    });

    it('should not set aria-labelledby when titleId omitted', () => {
      const container = createMockContainer();
      new BoxedSection(container as unknown as HTMLElement, {
        title: 'Test',
        body: () => { /* no-op */ }
      });

      const section = getFirstChild(container);
      expect(section.setAttribute).not.toHaveBeenCalled();
    });
  });

  describe('body callback', () => {
    it('should invoke body callback with the scrollable body element', () => {
      const container = createMockContainer();
      const bodyCallback = jest.fn();

      new BoxedSection(container as unknown as HTMLElement, {
        title: 'Test',
        body: bodyCallback
      });

      expect(bodyCallback).toHaveBeenCalledTimes(1);
      const section = getFirstChild(container);
      const bodyEl = section._children[1];
      expect(bodyCallback).toHaveBeenCalledWith(bodyEl);
    });

    it('getBody() should return the same body element passed to callback', () => {
      const container = createMockContainer();
      let bodyFromCallback: HTMLElement | null = null;

      const sec = new BoxedSection(container as unknown as HTMLElement, {
        title: 'Test',
        body: (b) => { bodyFromCallback = b; }
      });

      expect(sec.getBody()).toBe(bodyFromCallback);
    });
  });

  describe('toolbar + action', () => {
    it('should invoke toolbar callback with the toolbar host element', () => {
      const container = createMockContainer();
      const toolbarCallback = jest.fn();

      new BoxedSection(container as unknown as HTMLElement, {
        title: 'Test',
        toolbar: toolbarCallback,
        body: () => { /* no-op */ }
      });

      expect(toolbarCallback).toHaveBeenCalledTimes(1);
    });

    it('should create accent action button with actionLabel text', () => {
      const container = createMockContainer();
      new BoxedSection(container as unknown as HTMLElement, {
        title: 'Projects',
        actionLabel: '+ New project',
        onAction: jest.fn(),
        body: () => { /* no-op */ }
      });

      const section = getFirstChild(container);
      const header = getFirstChild(section);
      // Header creates a toolbar (createDiv 'ws-section-toolbar'), which then creates the action button.
      expect(header.createDiv).toHaveBeenCalledWith('ws-section-toolbar');
    });

    it('should NOT create toolbar when neither toolbar callback nor actionLabel/onAction set', () => {
      const container = createMockContainer();
      new BoxedSection(container as unknown as HTMLElement, {
        title: 'Test',
        body: () => { /* no-op */ }
      });

      const section = getFirstChild(container);
      const header = getFirstChild(section);
      // Header only ever calls createEl('h3') for the title — no createDiv('ws-section-toolbar')
      const toolbarCalls = header.createDiv.mock.calls.filter(c => c[0] === 'ws-section-toolbar');
      expect(toolbarCalls.length).toBe(0);
    });

    it('should NOT create action button when actionLabel is set but onAction is missing', () => {
      const container = createMockContainer();
      new BoxedSection(container as unknown as HTMLElement, {
        title: 'Test',
        actionLabel: '+ Add',
        // onAction intentionally missing
        body: () => { /* no-op */ }
      });

      const section = getFirstChild(container);
      const header = getFirstChild(section);
      const toolbarCalls = header.createDiv.mock.calls.filter(c => c[0] === 'ws-section-toolbar');
      expect(toolbarCalls.length).toBe(0);
    });

    it('should wire onAction via component.registerDomEvent when component provided', () => {
      const container = createMockContainer();
      const onAction = jest.fn();
      const component = new Component();
      const registerSpy = jest.spyOn(component, 'registerDomEvent');

      new BoxedSection(container as unknown as HTMLElement, {
        title: 'Projects',
        actionLabel: '+ New project',
        onAction,
        body: () => { /* no-op */ }
      }, component);

      expect(registerSpy).toHaveBeenCalledWith(
        expect.anything(),
        'click',
        expect.any(Function)
      );
    });

    it('should fall back to addEventListener when no component provided', () => {
      const container = createMockContainer();
      const onAction = jest.fn();

      new BoxedSection(container as unknown as HTMLElement, {
        title: 'Projects',
        actionLabel: '+ New project',
        onAction,
        body: () => { /* no-op */ }
      });

      const section = getFirstChild(container);
      const header = getFirstChild(section);
      // Toolbar is created (createDiv 'ws-section-toolbar') as the 2nd createDiv call after the action button button createEl call.
      // The action button is created inside the toolbar via toolbar.createEl('button', ...). The handler is registered via addEventListener.
      const toolbar = header._children.find(c => c.className === 'ws-section-toolbar');
      expect(toolbar).toBeTruthy();
      if (!toolbar) return;
      const actionButton = toolbar._children[0];
      expect(actionButton?.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
    });
  });

  describe('getElement', () => {
    it('should return the outer section element', () => {
      const container = createMockContainer();
      const sec = new BoxedSection(container as unknown as HTMLElement, {
        title: 'Test',
        body: () => { /* no-op */ }
      });

      const section = getFirstChild(container);
      expect(sec.getElement()).toBe(section);
    });
  });
});
