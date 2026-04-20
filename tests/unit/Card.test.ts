/**
 * Card Unit Tests
 *
 * Tests Card component config permutations and public methods.
 * Uses lightweight DOM mocking via obsidian mock's createMockElement.
 *
 * Coverage target: 80% (component logic, STANDARD risk)
 */

import { Card, CardConfig } from '../../src/components/Card';
import { Component } from 'obsidian';

// ============================================================================
// Helpers
// ============================================================================

type MockElementOptions = {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
};

type MockElement = {
  tagName: string;
  className: string;
  classList: {
    add: jest.Mock<void, [string]>;
    remove: jest.Mock<void, [string]>;
    toggle: jest.Mock<void, [string]>;
    contains: jest.Mock<boolean, [string]>;
  };
  addClass: jest.Mock<MockElement, [string]>;
  removeClass: jest.Mock<void, [string]>;
  hasClass: jest.Mock<boolean, [string]>;
  createEl: jest.Mock<MockElement, [string, MockElementOptions?]>;
  createDiv: jest.Mock<MockElement, [string | { cls?: string; text?: string }?]>;
  createSpan: jest.Mock<MockElement, [MockElementOptions?]>;
  empty: jest.Mock<void, []>;
  appendChild: jest.Mock<MockElement, [MockElement]>;
  removeChild: jest.Mock<void, [MockElement]>;
  addEventListener: jest.Mock<void, [string, EventListenerOrEventListenerObject]>;
  removeEventListener: jest.Mock<void, [string, EventListenerOrEventListenerObject]>;
  setAttribute: jest.Mock<void, [string, string]>;
  getAttribute: jest.Mock<string | null, [string]>;
  querySelector: jest.Mock<MockElement | null, [string]>;
  querySelectorAll: jest.Mock<MockElement[], [string]>;
  remove: jest.Mock<void, []>;
  style: Record<string, unknown>;
  textContent: string;
  innerHTML: string;
  setText: jest.Mock<void, [string]>;
  focus: jest.Mock<void, []>;
  _children: MockElement[];
  _attributes: Record<string, string>;
};

type MockContainer = MockElement & HTMLElement;

/**
 * Creates a mock container element that tracks child creation.
 * Mirrors the obsidian mock's createMockElement behavior.
 */
function createMockContainer(): MockContainer {
  const children: MockElement[] = [];

  const createElement = (cls?: string): MockElement => {
    const el: MockElement = {
      tagName: 'DIV',
      className: cls || '',
      classList: {
        add: jest.fn(),
        remove: jest.fn(),
        toggle: jest.fn(),
        contains: jest.fn((c: string) => el.className.includes(c)),
      },
      addClass: jest.fn((c: string) => { el.className += ' ' + c; }),
      removeClass: jest.fn(),
      hasClass: jest.fn((c: string) => el.className.includes(c)),
      createEl: jest.fn((tag: string, opts?: MockElementOptions) => {
        const child = createElement(opts?.cls || '');
        child.tagName = tag.toUpperCase();
        if (opts?.text) child.textContent = opts.text;
        if (opts?.attr) {
          for (const [k, v] of Object.entries(opts.attr)) {
            child._attributes[k] = v;
          }
        }
        el._children.push(child);
        return child;
      }),
      createDiv: jest.fn((cls2?: string | { cls?: string; text?: string }) => {
        const c = typeof cls2 === 'string' ? cls2 : cls2?.cls || '';
        const child = createElement(c);
        if (typeof cls2 === 'object' && cls2?.text) child.textContent = cls2.text;
        el._children.push(child);
        return child;
      }),
      createSpan: jest.fn((opts?: MockElementOptions) => {
        const child = createElement(opts?.cls || '');
        if (opts?.text) child.textContent = opts.text;
        el._children.push(child);
        return child;
      }),
      empty: jest.fn(() => { el._children = []; }),
      appendChild: jest.fn((child: MockElement) => { el._children.push(child); }),
      removeChild: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      setAttribute: jest.fn((k: string, v: string) => { el._attributes[k] = v; }),
      getAttribute: jest.fn((k: string) => el._attributes[k] || null),
      querySelector: jest.fn((sel: string) => {
        return findByClass(el, sel.replace('.', ''));
      }),
      querySelectorAll: jest.fn(() => []),
      remove: jest.fn(),
      style: {},
      textContent: '',
      innerHTML: '',
      setText: jest.fn((text: string) => { el.textContent = text; }),
      focus: jest.fn(),
      _children: [],
      _attributes: {} as Record<string, string>,
    };
    return el;
  };

  const container = createElement('') as MockContainer;
  container._children = children;
  return container;
}

/** Recursively search for an element with a given CSS class */
function findByClass(el: MockElement | null, cls: string): MockElement | null {
  if (!el) {
    return null;
  }
  if (el.className && el.className.includes(cls)) return el;
  for (const child of (el._children || [])) {
    const found = findByClass(child, cls);
    if (found) return found;
  }
  return null;
}

/** Recursively collect all elements matching a class */
function findAllByClass(el: MockElement | null, cls: string): MockElement[] {
  const results: MockElement[] = [];
  if (!el) {
    return results;
  }
  if (el.className && el.className.includes(cls)) results.push(el);
  for (const child of (el._children || [])) {
    results.push(...findAllByClass(child, cls));
  }
  return results;
}

function baseConfig(): CardConfig {
  return {
    title: 'Test Card',
    description: 'A test card description',
  };
}

// ============================================================================
// Card Component Tests
// ============================================================================

describe('Card', () => {

  // --------------------------------------------------------------------------
  // Basic rendering
  // --------------------------------------------------------------------------

  describe('basic rendering', () => {
    it('should create a card element in the container', () => {
      const container = createMockContainer();
      new Card(container, baseConfig());

      expect(container.createDiv).toHaveBeenCalledWith('agent-management-card');
    });

    it('should set the title text', () => {
      const container = createMockContainer();
      new Card(container, baseConfig());

      // The card creates a header with title div
      const cardEl = container._children[0];
      const titleEl = findByClass(cardEl, 'agent-management-card-title');
      expect(titleEl).toBeTruthy();
      expect(titleEl.setText).toHaveBeenCalledWith('Test Card');
    });

    it('should render description when non-empty', () => {
      const container = createMockContainer();
      new Card(container, { ...baseConfig(), description: 'My description' });

      const cardEl = container._children[0];
      const descEl = findByClass(cardEl, 'agent-management-card-description');
      expect(descEl).toBeTruthy();
      expect(descEl.setText).toHaveBeenCalledWith('My description');
    });

    it('should not render description when empty string', () => {
      const container = createMockContainer();
      new Card(container, { ...baseConfig(), description: '' });

      const cardEl = container._children[0];
      const descEl = findByClass(cardEl, 'agent-management-card-description');
      expect(descEl).toBeNull();
    });

    it('should not render description when whitespace only', () => {
      const container = createMockContainer();
      new Card(container, { ...baseConfig(), description: '   ' });

      const cardEl = container._children[0];
      const descEl = findByClass(cardEl, 'agent-management-card-description');
      expect(descEl).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Toggle behavior
  // --------------------------------------------------------------------------

  describe('toggle behavior', () => {
    it('should not render toggle when showToggle is false', () => {
      const container = createMockContainer();
      new Card(container, {
        ...baseConfig(),
        showToggle: false,
        onToggle: jest.fn(),
      });

      const cardEl = container._children[0];
      const toggleEl = findByClass(cardEl, 'agent-management-toggle');
      expect(toggleEl).toBeNull();
    });

    it('should not render toggle when onToggle is undefined', () => {
      const container = createMockContainer();
      new Card(container, {
        ...baseConfig(),
        showToggle: true,
        onToggle: undefined,
      });

      const cardEl = container._children[0];
      const toggleEl = findByClass(cardEl, 'agent-management-toggle');
      expect(toggleEl).toBeNull();
    });

    it('should render toggle when both showToggle and onToggle are provided', () => {
      const container = createMockContainer();
      new Card(container, {
        ...baseConfig(),
        showToggle: true,
        onToggle: jest.fn(),
        isEnabled: true,
      });

      const cardEl = container._children[0];
      const toggleEl = findByClass(cardEl, 'agent-management-toggle');
      expect(toggleEl).toBeTruthy();
    });
  });

  // --------------------------------------------------------------------------
  // Action buttons
  // --------------------------------------------------------------------------

  describe('action buttons', () => {
    it('should render edit button when onEdit is provided', () => {
      const container = createMockContainer();
      new Card(container, {
        ...baseConfig(),
        onEdit: jest.fn(),
      });

      const cardEl = container._children[0];
      const editBtn = findByClass(cardEl, 'agent-management-edit-btn');
      expect(editBtn).toBeTruthy();
    });

    it('should not render edit button when onEdit is undefined', () => {
      const container = createMockContainer();
      new Card(container, baseConfig());

      const cardEl = container._children[0];
      const editBtn = findByClass(cardEl, 'agent-management-edit-btn');
      expect(editBtn).toBeNull();
    });

    it('should render delete button when onDelete is provided', () => {
      const container = createMockContainer();
      new Card(container, {
        ...baseConfig(),
        onDelete: jest.fn(),
      });

      const cardEl = container._children[0];
      const deleteBtn = findByClass(cardEl, 'agent-management-delete-btn');
      expect(deleteBtn).toBeTruthy();
    });

    it('should not render delete button when onDelete is undefined', () => {
      const container = createMockContainer();
      new Card(container, baseConfig());

      const cardEl = container._children[0];
      const deleteBtn = findByClass(cardEl, 'agent-management-delete-btn');
      expect(deleteBtn).toBeNull();
    });

    it('should set aria-label on edit button', () => {
      const container = createMockContainer();
      new Card(container, {
        ...baseConfig(),
        onEdit: jest.fn(),
      });

      const cardEl = container._children[0];
      const editBtn = findByClass(cardEl, 'agent-management-edit-btn');
      expect(editBtn._attributes['aria-label']).toBe('Edit');
    });

    it('should set aria-label on delete button', () => {
      const container = createMockContainer();
      new Card(container, {
        ...baseConfig(),
        onDelete: jest.fn(),
      });

      const cardEl = container._children[0];
      const deleteBtn = findByClass(cardEl, 'agent-management-delete-btn');
      expect(deleteBtn._attributes['aria-label']).toBe('Delete');
    });

    it('should render additional action buttons', () => {
      const container = createMockContainer();
      new Card(container, {
        ...baseConfig(),
        additionalActions: [
          { icon: 'settings', label: 'Settings', onClick: jest.fn() },
          { icon: 'copy', label: 'Copy', onClick: jest.fn() },
        ],
      });

      const cardEl = container._children[0];
      const actionBtns = findAllByClass(cardEl, 'agent-management-action-btn');
      expect(actionBtns).toHaveLength(2);
    });

    it('should set aria-label on additional action buttons', () => {
      const container = createMockContainer();
      new Card(container, {
        ...baseConfig(),
        additionalActions: [
          { icon: 'settings', label: 'Settings', onClick: jest.fn() },
        ],
      });

      const cardEl = container._children[0];
      const actionBtn = findByClass(cardEl, 'agent-management-action-btn');
      expect(actionBtn._attributes['aria-label']).toBe('Settings');
    });
  });

  // --------------------------------------------------------------------------
  // Public methods
  // --------------------------------------------------------------------------

  describe('public methods', () => {
    it('should return card element via getElement()', () => {
      const container = createMockContainer();
      const card = new Card(container, baseConfig());
      const el = card.getElement();
      expect(el).toBeTruthy();
    });

    it('should report isEnabled() correctly when enabled', () => {
      const container = createMockContainer();
      const card = new Card(container, { ...baseConfig(), isEnabled: true });
      expect(card.isEnabled()).toBe(true);
    });

    it('should report isEnabled() correctly when disabled', () => {
      const container = createMockContainer();
      const card = new Card(container, { ...baseConfig(), isEnabled: false });
      expect(card.isEnabled()).toBe(false);
    });

    it('should default isEnabled to false when not specified', () => {
      const container = createMockContainer();
      const card = new Card(container, baseConfig());
      expect(card.isEnabled()).toBe(false);
    });

    it('should update enabled state via setEnabled()', () => {
      const container = createMockContainer();
      const card = new Card(container, { ...baseConfig(), isEnabled: false });
      card.setEnabled(true);
      expect(card.isEnabled()).toBe(true);
    });

    it('should remove card from DOM via remove()', () => {
      const container = createMockContainer();
      const card = new Card(container, baseConfig());
      const el = card.getElement();
      card.remove();
      expect(el.remove).toHaveBeenCalled();
    });

    it('should update title via setTitle()', () => {
      const container = createMockContainer();
      const card = new Card(container, baseConfig());

      // setTitle calls querySelector('.agent-management-card-title')
      const cardEl = card.getElement() as MockContainer;
      const titleEl = findByClass(cardEl, 'agent-management-card-title');
      cardEl.querySelector = jest.fn(() => titleEl);

      card.setTitle('New Title');
      expect(titleEl.textContent).toBe('New Title');
    });

    it('should update description via setDescription()', () => {
      const container = createMockContainer();
      const card = new Card(container, baseConfig());

      const cardEl = card.getElement() as MockContainer;

      // Mock querySelector for existing description
      const existingDesc = findByClass(cardEl, 'agent-management-card-description');
      cardEl.querySelector = jest.fn(() => existingDesc);

      card.setDescription('Updated description');
      // Should have called createDiv for new description
      expect(cardEl.createDiv).toHaveBeenCalledWith('agent-management-card-description');
    });
  });

  // --------------------------------------------------------------------------
  // Config permutations
  // --------------------------------------------------------------------------

  describe('config permutations', () => {
    it('should render card with all options enabled', () => {
      const container = createMockContainer();
      const card = new Card(container, {
        title: 'Full Card',
        description: 'All features',
        isEnabled: true,
        showToggle: true,
        onToggle: jest.fn(),
        onEdit: jest.fn(),
        onDelete: jest.fn(),
        additionalActions: [
          { icon: 'gear', label: 'Config', onClick: jest.fn() },
        ],
      });

      expect(card.getElement()).toBeTruthy();
      expect(card.isEnabled()).toBe(true);
    });

    it('should render minimal card with only required fields', () => {
      const container = createMockContainer();
      const card = new Card(container, {
        title: 'Minimal',
        description: '',
      });

      expect(card.getElement()).toBeTruthy();
    });
  });

  // --------------------------------------------------------------------------
  // updateConfig()
  // --------------------------------------------------------------------------

  describe('updateConfig()', () => {
    it('should refresh the card with updated config', () => {
      const container = createMockContainer();
      const card = new Card(container, baseConfig());

      const oldEl = card.getElement();
      card.updateConfig({ title: 'Updated Title' });

      // After updateConfig, the old element should be removed and a new one created
      expect(oldEl.remove).toHaveBeenCalled();
    });

    it('should merge partial config with existing config', () => {
      const container = createMockContainer();
      const card = new Card(container, { ...baseConfig(), isEnabled: true });

      card.updateConfig({ title: 'New Title' });
      // isEnabled should still be true after partial update
      expect(card.isEnabled()).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // safeRegisterDomEvent with Component
  // --------------------------------------------------------------------------

  describe('safeRegisterDomEvent with Component', () => {
    it('should use component.registerDomEvent when component is provided', () => {
      const container = createMockContainer();
      const component = new Component();
      const registerSpy = jest.spyOn(component, 'registerDomEvent');

      new Card(container, {
        ...baseConfig(),
        onEdit: jest.fn(),
      }, component);

      // registerDomEvent should have been called for the edit button click handler
      expect(registerSpy).toHaveBeenCalled();
      const call = registerSpy.mock.calls[0];
      expect(call[1]).toBe('click');
    });

    it('should fall back to addEventListener when no component', () => {
      const container = createMockContainer();
      const onEdit = jest.fn();
      new Card(container, {
        ...baseConfig(),
        onEdit,
      });

      // Without component, edit button should use addEventListener
      const cardEl = container._children[0];
      const editBtn = findByClass(cardEl, 'agent-management-edit-btn');
      expect(editBtn).toBeTruthy();
      expect(editBtn.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
    });

    it('should register all action button events via component when provided', () => {
      const container = createMockContainer();
      const component = new Component();
      const registerSpy = jest.spyOn(component, 'registerDomEvent');

      new Card(container, {
        ...baseConfig(),
        onEdit: jest.fn(),
        onDelete: jest.fn(),
        additionalActions: [
          { icon: 'settings', label: 'Settings', onClick: jest.fn() },
        ],
      }, component);

      // Should have 3 click registrations: edit, delete, settings action
      const clickCalls = registerSpy.mock.calls.filter(c => c[1] === 'click');
      expect(clickCalls).toHaveLength(3);
    });
  });

  // --------------------------------------------------------------------------
  // setDescription edge cases
  // --------------------------------------------------------------------------

  describe('setDescription edge cases', () => {
    it('should remove description when set to empty string', () => {
      const container = createMockContainer();
      const card = new Card(container, baseConfig());
      const cardEl = card.getElement() as MockContainer;

      const existingDesc = findByClass(cardEl, 'agent-management-card-description');
      cardEl.querySelector = jest.fn(() => existingDesc);

      card.setDescription('');
      // Should have called remove on the existing description
      if (existingDesc) {
        expect(existingDesc.remove).toHaveBeenCalled();
      }
      // Should NOT create a new description div for empty string
    });

    it('should remove description when set to whitespace', () => {
      const container = createMockContainer();
      const card = new Card(container, baseConfig());
      const cardEl = card.getElement() as MockContainer;

      const existingDesc = findByClass(cardEl, 'agent-management-card-description');
      cardEl.querySelector = jest.fn(() => existingDesc);

      card.setDescription('   ');
      if (existingDesc) {
        expect(existingDesc.remove).toHaveBeenCalled();
      }
    });
  });
});
