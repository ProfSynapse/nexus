/**
 * CardManager Unit Tests
 *
 * Tests CardManager CRUD lifecycle: empty state, item rendering,
 * add button visibility, and updateItems().
 *
 * Coverage target: 75% (component logic, STANDARD risk)
 */

import { CardManager, CardManagerConfig, CardItem } from '../../src/components/CardManager';

// ============================================================================
// Helpers
// ============================================================================

type MockCardElement = {
  tagName: string;
  className: string;
  classList: {
    add: jest.Mock<void, [string]>;
    remove: jest.Mock<void, [string]>;
    toggle: jest.Mock<void, [string]>;
    contains: jest.Mock<boolean, [string]>;
  };
  addClass: jest.Mock<MockCardElement, [string]>;
  removeClass: jest.Mock<MockCardElement, []>;
  hasClass: jest.Mock<boolean, []>;
  createEl: jest.Mock<MockCardElement, [string, { cls?: string; text?: string; attr?: Record<string, string> }?]>;
  createDiv: jest.Mock<MockCardElement, [string | { cls?: string; text?: string }?]>;
  createSpan: jest.Mock<MockCardElement, [{ cls?: string; text?: string }?]>;
  empty: jest.Mock<void, []>;
  appendChild: jest.Mock<void, [MockCardElement]>;
  removeChild: jest.Mock<void, [MockCardElement]>;
  addEventListener: jest.Mock<void, [string, EventListenerOrEventListenerObject]>;
  removeEventListener: jest.Mock<void, [string, EventListenerOrEventListenerObject]>;
  setAttribute: jest.Mock<void, [string, string]>;
  getAttribute: jest.Mock<string | null, [string]>;
  querySelector: jest.Mock<MockCardElement | null, [string]>;
  querySelectorAll: jest.Mock<MockCardElement[], [string]>;
  remove: jest.Mock<void, []>;
  style: Record<string, unknown>;
  textContent: string;
  innerHTML: string;
  setText: jest.Mock<void, [string]>;
  focus: jest.Mock<void, []>;
  _children: MockCardElement[];
  _attributes: Record<string, string>;
};

function createMockContainer(): MockCardElement {
  const createElement = (cls = ''): MockCardElement => {
    const el: MockCardElement = {
      tagName: 'DIV',
      className: cls,
      classList: {
        add: jest.fn(),
        remove: jest.fn(),
        toggle: jest.fn(),
        contains: jest.fn((c: string) => el.className.includes(c)),
      },
      addClass: jest.fn((c: string) => { el.className += ' ' + c; }),
      removeClass: jest.fn(),
      hasClass: jest.fn(),
      createEl: jest.fn((tag: string, opts?: { cls?: string; text?: string; attr?: Record<string, string> }) => {
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
      createSpan: jest.fn((opts?: { cls?: string; text?: string }) => {
        const child = createElement(opts?.cls || '');
        if (opts?.text) child.textContent = opts.text;
        el._children.push(child);
        return child;
      }),
      empty: jest.fn(() => { el._children = []; }),
      appendChild: jest.fn(),
      removeChild: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      setAttribute: jest.fn((k: string, v: string) => { el._attributes[k] = v; }),
      getAttribute: jest.fn((k: string) => el._attributes[k] || null),
      querySelector: jest.fn(),
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

  return createElement('');
}

function makeItem(id: string, name: string, isEnabled = true): CardItem {
  return { id, name, description: `${name} description`, isEnabled };
}

function makeConfig(
  container: MockCardElement,
  items: CardItem[] = [],
  overrides: Partial<CardManagerConfig<CardItem>> = {}
): CardManagerConfig<CardItem> {
  return {
    containerEl: container,
    title: 'Test Manager',
    addButtonText: 'Add Item',
    emptyStateText: 'No items yet',
    items,
    onAdd: jest.fn(),
    onToggle: jest.fn().mockResolvedValue(undefined),
    onEdit: jest.fn(),
    onDelete: jest.fn(),
    ...overrides,
  };
}

/** Find child elements by class name (shallow scan) */
function findChildByClass(el: MockCardElement | null, cls: string): MockCardElement | null {
  if (!el) return null;
  for (const child of (el._children || [])) {
    if (child.className && child.className.includes(cls)) return child;
    const found = findChildByClass(child, cls);
    if (found) return found;
  }
  return null;
}

function countChildrenByClass(el: MockCardElement | null, cls: string, exact = false): number {
  if (!el) return 0;
  let count = 0;
  if (el.className) {
    if (exact) {
      // Exact match: class is exactly the string (no additional words)
      if (el.className.trim() === cls) count++;
    } else {
      if (el.className.includes(cls)) count++;
    }
  }
  for (const child of (el._children || [])) {
    count += countChildrenByClass(child, cls, exact);
  }
  return count;
}

function expectCard<T extends CardItem>(manager: CardManager<T>, id: string) {
  const card = manager.getCard(id);
  if (!card) {
    throw new Error(`Expected card ${id}`);
  }
  return card;
}

// ============================================================================
// CardManager Tests
// ============================================================================

describe('CardManager', () => {

  // --------------------------------------------------------------------------
  // Empty state
  // --------------------------------------------------------------------------

  describe('empty state', () => {
    it('should render empty state text when no items', () => {
      const container = createMockContainer();
      new CardManager(makeConfig(container, []));

      // CardManager calls containerEl.empty(), then creates children
      // The cards container should have the empty state div
      const cardsContainer = findChildByClass(container, 'card-manager-grid');
      expect(cardsContainer).toBeTruthy();
      const emptyState = findChildByClass(cardsContainer, 'card-manager-empty');
      expect(emptyState).toBeTruthy();
      expect(emptyState.setText).toHaveBeenCalledWith('No items yet');
    });
  });

  // --------------------------------------------------------------------------
  // Card rendering
  // --------------------------------------------------------------------------

  describe('card rendering', () => {
    it('should create a card for each item', () => {
      const container = createMockContainer();
      const items = [
        makeItem('1', 'Item A'),
        makeItem('2', 'Item B'),
        makeItem('3', 'Item C'),
      ];
      new CardManager(makeConfig(container, items));

      const cardsContainer = findChildByClass(container, 'card-manager-grid');
      // Each item creates an agent-management-card div (exact match to avoid counting child elements)
      const cardCount = countChildrenByClass(cardsContainer, 'agent-management-card', true);
      expect(cardCount).toBe(3);
    });

    it('should not render empty state when items exist', () => {
      const container = createMockContainer();
      new CardManager(makeConfig(container, [makeItem('1', 'Test')]));

      const cardsContainer = findChildByClass(container, 'card-manager-grid');
      const emptyState = findChildByClass(cardsContainer, 'card-manager-empty');
      expect(emptyState).toBeNull();
    });

    it('should hide the toggle for items that override showToggle to false', () => {
      const container = createMockContainer();
      const items = [{ ...makeItem('1', 'Install only'), showToggle: false }];
      new CardManager(makeConfig(container, items, { showToggle: true }));

      const cardEl = findChildByClass(container, 'agent-management-card');
      const toggleEl = findChildByClass(cardEl, 'agent-management-toggle');
      expect(toggleEl).toBeNull();
    });

    it('should hide the edit button for items that override showEdit to false', () => {
      const container = createMockContainer();
      const items = [{ ...makeItem('1', 'No edit'), showEdit: false }];
      new CardManager(makeConfig(container, items));

      const cardEl = findChildByClass(container, 'agent-management-card');
      const editBtn = findChildByClass(cardEl, 'agent-management-edit-btn');
      expect(editBtn).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Add button
  // --------------------------------------------------------------------------

  describe('add button', () => {
    it('should render add button by default', () => {
      const container = createMockContainer();
      new CardManager(makeConfig(container, []));

      const addBtn = findChildByClass(container, 'card-manager-add-button');
      expect(addBtn).toBeTruthy();
    });

    it('should not render add button when showAddButton is false', () => {
      const container = createMockContainer();
      new CardManager(makeConfig(container, [], { showAddButton: false }));

      const addBtn = findChildByClass(container, 'card-manager-add-button');
      expect(addBtn).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // updateItems()
  // --------------------------------------------------------------------------

  describe('updateItems()', () => {
    it('should refresh display with new items', () => {
      const container = createMockContainer();
      const manager = new CardManager(makeConfig(container, [makeItem('1', 'Original')]));

      const newItems = [
        makeItem('2', 'New A'),
        makeItem('3', 'New B'),
      ];
      manager.updateItems(newItems);

      // After updateItems, refreshCards is called which empties and repopulates
      const cardsContainer = findChildByClass(container, 'card-manager-grid');
      expect(cardsContainer).toBeTruthy();
      // The cardsContainer.empty() was called, then new cards created
      expect(cardsContainer.empty).toHaveBeenCalled();
    });

    it('should show empty state after updating with empty array', () => {
      const container = createMockContainer();
      const manager = new CardManager(makeConfig(container, [makeItem('1', 'Item')]));

      manager.updateItems([]);

      const cardsContainer = findChildByClass(container, 'card-manager-grid');
      expect(cardsContainer).toBeTruthy();
      // After empty() and repopulation with 0 items, should create empty state
      const emptyState = findChildByClass(cardsContainer, 'card-manager-empty');
      expect(emptyState).toBeTruthy();
    });
  });

  // --------------------------------------------------------------------------
  // getCard()
  // --------------------------------------------------------------------------

  describe('getCard()', () => {
    it('should return card by item ID', () => {
      const container = createMockContainer();
      const manager = new CardManager(makeConfig(container, [makeItem('abc', 'ABC Item')]));

      const card = manager.getCard('abc');
      expect(card).toBeDefined();
    });

    it('should return undefined for non-existent ID', () => {
      const container = createMockContainer();
      const manager = new CardManager(makeConfig(container, [makeItem('1', 'Item')]));

      const card = manager.getCard('nonexistent');
      expect(card).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Toggle behavior
  // --------------------------------------------------------------------------

  describe('toggle configuration', () => {
    it('should enable toggle by default (showToggle not explicitly false)', () => {
      const container = createMockContainer();
      new CardManager(makeConfig(container, [makeItem('1', 'Item')]));

      // showToggle defaults to !== false, so toggle should be rendered
      const cardsContainer = findChildByClass(container, 'card-manager-grid');
      const toggleEl = findChildByClass(cardsContainer, 'agent-management-toggle');
      expect(toggleEl).toBeTruthy();
    });

    it('should hide toggle when showToggle is false', () => {
      const container = createMockContainer();
      new CardManager(makeConfig(container, [makeItem('1', 'Item')], { showToggle: false }));

      const cardsContainer = findChildByClass(container, 'card-manager-grid');
      const toggleEl = findChildByClass(cardsContainer, 'agent-management-toggle');
      expect(toggleEl).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // cssClass application
  // --------------------------------------------------------------------------

  describe('cssClass on CardItem', () => {
    it('should apply cssClass to the card element when provided', () => {
      const container = createMockContainer();
      const items: CardItem[] = [{
        id: 'coming-soon',
        name: 'Perplexity',
        description: 'Coming Soon',
        isEnabled: false,
        cssClass: 'provider-coming-soon',
      }];

      const manager = new CardManager(makeConfig(container, items));
      const card = expectCard(manager, 'coming-soon');
      // Card.getElement().addClass should have been called with the cssClass
      expect(card.getElement().addClass).toHaveBeenCalledWith('provider-coming-soon');
    });

    it('should not call addClass when cssClass is undefined', () => {
      const container = createMockContainer();
      const items: CardItem[] = [{
        id: 'normal',
        name: 'OpenAI',
        description: 'Configured',
        isEnabled: true,
        // No cssClass
      }];

      const manager = new CardManager(makeConfig(container, items));
      const card = expectCard(manager, 'normal');
      // Card is created by CardManager.createCard; the parent element will have
      // agent-management-card class, but no extra addClass call for cssClass
      const el = card.getElement();
      // addClass is called by Card itself for its own structure, but not with a custom class
      const addClassCalls = (el.addClass as jest.Mock).mock.calls;
      const customClassCalls = addClassCalls.filter(
        (call: unknown[]) => call[0] === 'provider-coming-soon'
      );
      expect(customClassCalls).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Multiple items with mixed cssClass
  // --------------------------------------------------------------------------

  describe('multiple items with mixed cssClass', () => {
    it('should apply cssClass only to items that have it', () => {
      const container = createMockContainer();
      const items: CardItem[] = [
        { id: 'a', name: 'A', isEnabled: true },
        { id: 'b', name: 'B', isEnabled: false, cssClass: 'special-class' },
        { id: 'c', name: 'C', isEnabled: true },
      ];

      const manager = new CardManager(makeConfig(container, items));

      // Item A should not have cssClass applied
      const cardA = expectCard(manager, 'a');
      const addClassCallsA = cardA.getElement().addClass.mock.calls;
      expect(addClassCallsA.filter((c: unknown[]) => c[0] === 'special-class')).toHaveLength(0);

      // Item B should have cssClass applied
      const cardB = expectCard(manager, 'b');
      expect(cardB.getElement().addClass).toHaveBeenCalledWith('special-class');

      // Item C should not have cssClass applied
      const cardC = expectCard(manager, 'c');
      const addClassCallsC = cardC.getElement().addClass.mock.calls;
      expect(addClassCallsC.filter((c: unknown[]) => c[0] === 'special-class')).toHaveLength(0);
    });
  });
});
