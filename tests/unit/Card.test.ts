/**
 * Card Unit Tests
 *
 * Tests Card component config permutations and public methods.
 * Uses lightweight DOM mocking via obsidian mock's createMockElement.
 *
 * Coverage target: 80% (component logic, STANDARD risk)
 */

import { Card, CardConfig } from '../../src/components/Card';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Creates a mock container element that tracks child creation.
 * Mirrors the obsidian mock's createMockElement behavior.
 */
function createMockContainer(): HTMLElement & { _children: HTMLElement[] } {
  const children: HTMLElement[] = [];

  const createElement = (cls?: string): HTMLElement => {
    const el: any = {
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
      createEl: jest.fn((tag: string, opts?: any) => {
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
      createSpan: jest.fn((opts?: any) => {
        const child = createElement(opts?.cls || '');
        if (opts?.text) child.textContent = opts.text;
        el._children.push(child);
        return child;
      }),
      empty: jest.fn(() => { el._children = []; }),
      appendChild: jest.fn((child: any) => { el._children.push(child); }),
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
      _children: [] as any[],
      _attributes: {} as Record<string, string>,
    };
    return el;
  };

  const container = createElement('') as any;
  container._children = children;
  return container;
}

/** Recursively search for an element with a given CSS class */
function findByClass(el: any, cls: string): any {
  if (el.className && el.className.includes(cls)) return el;
  for (const child of (el._children || [])) {
    const found = findByClass(child, cls);
    if (found) return found;
  }
  return null;
}

/** Recursively collect all elements matching a class */
function findAllByClass(el: any, cls: string): any[] {
  const results: any[] = [];
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
      const card = new Card(container, baseConfig());

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
      const cardEl = card.getElement();
      const titleEl = findByClass(cardEl, 'agent-management-card-title');
      (cardEl as any).querySelector = jest.fn(() => titleEl);

      card.setTitle('New Title');
      expect(titleEl.textContent).toBe('New Title');
    });

    it('should update description via setDescription()', () => {
      const container = createMockContainer();
      const card = new Card(container, baseConfig());

      const cardEl = card.getElement();

      // Mock querySelector for existing description
      const existingDesc = findByClass(cardEl, 'agent-management-card-description');
      (cardEl as any).querySelector = jest.fn(() => existingDesc);

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
});
