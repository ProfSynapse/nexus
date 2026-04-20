/**
 * BackButton Unit Tests
 *
 * Tests BackButton renders correctly and fires click callback.
 *
 * Coverage target: 60% (simple component, STANDARD risk)
 */

import { BackButton } from '../../src/settings/components/BackButton';
import { Component } from 'obsidian';

// ============================================================================
// Helpers
// ============================================================================

type MockElement = {
  tagName: string;
  className: string;
  classList: {
    add: jest.Mock<void, [string]>;
    remove: jest.Mock<void, [string]>;
    toggle: jest.Mock<void, [string]>;
    contains: jest.Mock<boolean, [string]>;
  };
  addClass: jest.Mock<void, [string]>;
  removeClass: jest.Mock<void, [string]>;
  hasClass: jest.Mock<boolean, [string]>;
  createEl: jest.Mock<MockElement, [string, { cls?: string }?]>;
  createDiv: jest.Mock<MockElement, [string | { cls?: string }?]>;
  createSpan: jest.Mock<MockElement, [{ cls?: string; text?: string }?]>;
  empty: jest.Mock<void, []>;
  appendChild: jest.Mock<void, [MockElement]>;
  addEventListener: jest.Mock<void, [string, () => void]>;
  removeEventListener: jest.Mock<void, [string, () => void]>;
  setAttribute: jest.Mock<void, [string, string]>;
  getAttribute: jest.Mock<string | null, [string]>;
  querySelector: jest.Mock<null, [string]>;
  querySelectorAll: jest.Mock<MockElement[], [string]>;
  remove: jest.Mock<void, []>;
  style: Record<string, string>;
  textContent: string;
  innerHTML: string;
  setText: jest.Mock<void, [string]>;
  focus: jest.Mock<void, []>;
  _children: MockElement[];
};

function createMockContainer(): MockElement {
  const createElement = (cls?: string): MockElement => {
    const el: MockElement = {
      tagName: 'DIV',
      className: cls || '',
      classList: {
        add: jest.fn(),
        remove: jest.fn(),
        toggle: jest.fn(),
        contains: jest.fn(),
      },
      addClass: jest.fn(),
      removeClass: jest.fn(),
      hasClass: jest.fn(),
      createEl: jest.fn((_tag?: string, opts?: { cls?: string }) => {
        const child = createElement(opts?.cls || '');
        child.tagName = (_tag || 'DIV').toUpperCase();
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
        child.textContent = opts?.text || '';
        el._children.push(child);
        return child;
      }),
      empty: jest.fn(),
      appendChild: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      setAttribute: jest.fn(),
      getAttribute: jest.fn(),
      querySelector: jest.fn(),
      querySelectorAll: jest.fn(() => []),
      remove: jest.fn(),
      style: {},
      textContent: '',
      innerHTML: '',
      setText: jest.fn(),
      focus: jest.fn(),
      _children: [],
    };
    return el;
  };

  return createElement('');
}

// ============================================================================
// BackButton Tests
// ============================================================================

describe('BackButton', () => {

  // --------------------------------------------------------------------------
  // Rendering
  // --------------------------------------------------------------------------

  describe('rendering', () => {
    it('should create a back button element in the container', () => {
      const container = createMockContainer();
      new BackButton(container as unknown as HTMLElement, 'Back to list', jest.fn());

      expect(container.createEl).toHaveBeenCalledWith('button', {
        cls: 'clickable-icon nexus-back-button'
      });
    });

    it('should create an icon span with chevron-left icon class', () => {
      const container = createMockContainer();
      new BackButton(container as unknown as HTMLElement, 'Back to Workspaces', jest.fn());

      const buttonEl = container._children[0];
      if (!buttonEl) {
        throw new Error('Missing button element');
      }
      expect(buttonEl.createSpan).toHaveBeenCalledWith(
        expect.objectContaining({ cls: 'nexus-back-button-icon' })
      );
    });

    it('should create a label span with the provided text', () => {
      const container = createMockContainer();
      new BackButton(container as unknown as HTMLElement, 'Back to Providers', jest.fn());

      const buttonEl = container._children[0];
      if (!buttonEl) {
        throw new Error('Missing button element');
      }
      expect(buttonEl.createSpan).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Back to Providers' })
      );
    });
  });

  // --------------------------------------------------------------------------
  // Click handling
  // --------------------------------------------------------------------------

  describe('click handling', () => {
    it('should register click handler via addEventListener when no component', () => {
      const container = createMockContainer();
      const onClick = jest.fn();
      new BackButton(container as unknown as HTMLElement, 'Back', onClick);

      const buttonEl = container._children[0];
      if (!buttonEl) {
        throw new Error('Missing button element');
      }
      expect(buttonEl.addEventListener).toHaveBeenCalledWith('click', onClick);
    });

    it('should register click handler via component.registerDomEvent when component provided', () => {
      const container = createMockContainer();
      const onClick = jest.fn();
      const component = new Component();

      const registerSpy = jest.spyOn(component, 'registerDomEvent');
      new BackButton(container as unknown as HTMLElement, 'Back', onClick, component);

      expect(registerSpy).toHaveBeenCalledWith(
        expect.anything(),
        'click',
        onClick
      );
    });
  });

  // --------------------------------------------------------------------------
  // Public methods
  // --------------------------------------------------------------------------

  describe('public methods', () => {
    it('should return the element via getElement()', () => {
      const container = createMockContainer();
      const button = new BackButton(container as unknown as HTMLElement, 'Back', jest.fn());
      const el = button.getElement();
      expect(el).toBeTruthy();
    });

    it('should remove element from DOM via destroy()', () => {
      const container = createMockContainer();
      const button = new BackButton(container as unknown as HTMLElement, 'Back', jest.fn());
      const el = button.getElement();

      button.destroy();
      expect(el.remove).toHaveBeenCalled();
    });
  });
});
