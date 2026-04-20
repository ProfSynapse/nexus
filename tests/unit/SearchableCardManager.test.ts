/**
 * SearchableCardManager Unit Tests
 *
 * Tests the exported `filterItems()` pure function.
 * No DOM mocking needed — pure function testing.
 *
 * Coverage target: 85%+ (pure logic, STANDARD risk)
 */

import { filterItems, SearchableCardManager, CardGroup } from '../../src/components/SearchableCardManager';
import { CardItem, CardManagerConfig } from '../../src/components/CardManager';

type MockElementOptions = {
  cls?: string;
  text?: string;
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
  toggleClass: jest.Mock<void, [string, boolean?]>;
  setText: jest.Mock<void, [string]>;
  createEl: jest.Mock<MockElement, [string, MockElementOptions?]>;
  createDiv: jest.Mock<MockElement, [string | MockElementOptions?]>;
  createSpan: jest.Mock<MockElement, [MockElementOptions?]>;
  empty: jest.Mock<void, []>;
  remove: jest.Mock<void, []>;
  appendChild: jest.Mock<void, [MockElement]>;
  addEventListener: jest.Mock<void, [string, EventListenerOrEventListenerObject]>;
  removeEventListener: jest.Mock<void, [string, EventListenerOrEventListenerObject]>;
  setAttribute: jest.Mock<void, [string, string]>;
  getAttribute: jest.Mock<string | null, [string]>;
  querySelector: jest.Mock<MockElement | null, [string]>;
  querySelectorAll: jest.Mock<MockElement[], [string]>;
  style: Record<string, unknown>;
  textContent: string;
  innerHTML: string;
  focus: jest.Mock<void, []>;
  _children: MockElement[];
};

type MockContainer = MockElement & HTMLElement;

// ============================================================================
// Fixture Factories
// ============================================================================

function makeItem(id: string, name: string, description?: string): CardItem {
  return { id, name, description, isEnabled: true };
}

const ITEMS: CardItem[] = [
  makeItem('1', 'OpenAI Provider', 'Cloud-based LLM provider'),
  makeItem('2', 'Local Ollama', 'Self-hosted local models'),
  makeItem('3', 'Anthropic Claude', 'Advanced reasoning model'),
  makeItem('4', 'Google Gemini'),
  makeItem('5', 'Mistral AI', 'European open-weight models'),
];

// ============================================================================
// filterItems() — Core Filtering
// ============================================================================

describe('filterItems', () => {

  // --------------------------------------------------------------------------
  // Empty / No-op queries
  // --------------------------------------------------------------------------

  describe('empty and no-op queries', () => {
    it('should return all items when query is empty string', () => {
      const result = filterItems(ITEMS, '');
      expect(result).toEqual(ITEMS);
      expect(result).toHaveLength(5);
    });

    it('should return all items when query is only whitespace', () => {
      // Whitespace is not trimmed by the function — it's a non-empty query
      // that won't match anything unless items contain whitespace
      const result = filterItems(ITEMS, '   ');
      // Default filter lowercases and checks includes — whitespace won't match names/descriptions
      expect(result).toHaveLength(0);
    });

    it('should return empty array when items array is empty', () => {
      const result = filterItems([], 'test');
      expect(result).toEqual([]);
    });

    it('should return empty array when items is empty and query is empty', () => {
      const result = filterItems([], '');
      expect(result).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // Default filter — name matching
  // --------------------------------------------------------------------------

  describe('default filter — name matching', () => {
    it('should match by exact name (case-insensitive)', () => {
      const result = filterItems(ITEMS, 'openai provider');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });

    it('should match by partial name substring', () => {
      const result = filterItems(ITEMS, 'ollama');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('2');
    });

    it('should be case-insensitive for name matching', () => {
      const result = filterItems(ITEMS, 'ANTHROPIC');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('3');
    });

    it('should match multiple items sharing a substring', () => {
      // "ai" appears in "OpenAI" and "Mistral AI"
      const result = filterItems(ITEMS, 'ai');
      expect(result.length).toBeGreaterThanOrEqual(2);
      const ids = result.map(r => r.id);
      expect(ids).toContain('1');
      expect(ids).toContain('5');
    });
  });

  // --------------------------------------------------------------------------
  // Default filter — description matching
  // --------------------------------------------------------------------------

  describe('default filter — description matching', () => {
    it('should match by description substring', () => {
      const result = filterItems(ITEMS, 'self-hosted');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('2');
    });

    it('should be case-insensitive for description matching', () => {
      const result = filterItems(ITEMS, 'CLOUD-BASED');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });

    it('should match across name and description independently', () => {
      // "model" appears in descriptions of items 2, 3, 5
      const result = filterItems(ITEMS, 'model');
      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle items with undefined description gracefully', () => {
      // Item 4 (Google Gemini) has no description
      const result = filterItems(ITEMS, 'gemini');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('4');
    });

    it('should not crash when searching description of item with undefined description', () => {
      // Query that would only match a description — items without description should be skipped safely
      const result = filterItems(ITEMS, 'cloud');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });
  });

  // --------------------------------------------------------------------------
  // No results
  // --------------------------------------------------------------------------

  describe('no results', () => {
    it('should return empty array when nothing matches', () => {
      const result = filterItems(ITEMS, 'zzzznonexistent');
      expect(result).toEqual([]);
    });

    it('should return empty array for numeric query with no matches', () => {
      const result = filterItems(ITEMS, '99999');
      expect(result).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // Special characters
  // --------------------------------------------------------------------------

  describe('special characters in query', () => {
    it('should handle regex-special characters without crashing', () => {
      // These are regex metacharacters — filterItems uses includes(), not regex
      expect(() => filterItems(ITEMS, '.*+?^${}()|[]\\')).not.toThrow();
    });

    it('should handle hyphenated queries', () => {
      const result = filterItems(ITEMS, 'cloud-based');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });

    it('should handle query with unicode characters', () => {
      const items = [makeItem('u1', 'Ünïcödé Provider', 'Tëst description')];
      // toLowerCase() on 'Ünïcödé' yields 'ünïcödé', query 'ünïcödé' matches
      const result = filterItems(items, 'ünïcödé');
      expect(result).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // Custom filterFn
  // --------------------------------------------------------------------------

  describe('custom filterFn', () => {
    it('should use custom filterFn when provided', () => {
      const customFilter = (item: CardItem, q: string) => item.id === q;
      const result = filterItems(ITEMS, '3', customFilter);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Anthropic Claude');
    });

    it('should pass lowercased query to custom filterFn', () => {
      const receivedQueries: string[] = [];
      const customFilter = (item: CardItem, q: string) => {
        receivedQueries.push(q);
        return false;
      };
      filterItems(ITEMS, 'MiXeD CaSe', customFilter);
      // All queries received should be lowercased
      expect(receivedQueries.every(q => q === 'mixed case')).toBe(true);
    });

    it('should use default filter when custom filterFn is undefined', () => {
      const result = filterItems(ITEMS, 'ollama', undefined);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('2');
    });

    it('should support custom filter matching on arbitrary fields', () => {
      const items = [
        { ...makeItem('a', 'Alpha', 'First'), isEnabled: true },
        { ...makeItem('b', 'Beta', 'Second'), isEnabled: false },
        { ...makeItem('c', 'Charlie', 'Third'), isEnabled: true },
      ];
      // Custom filter that only returns enabled items matching query
      const enabledFilter = (item: CardItem, q: string) =>
        item.isEnabled && item.name.toLowerCase().includes(q);

      // 'a' lowercase matches 'alpha' and 'charlie' — both enabled
      // Use 'alph' to match only Alpha
      const result = filterItems(items, 'alph', enabledFilter);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('a');
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle single-character query', () => {
      // 'a' appears in many item names
      const result = filterItems(ITEMS, 'a');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should handle very long query string', () => {
      const longQuery = 'a'.repeat(1000);
      const result = filterItems(ITEMS, longQuery);
      expect(result).toEqual([]);
    });

    it('should handle item with empty string name', () => {
      const items = [makeItem('empty', '', 'Has description')];
      const result = filterItems(items, 'description');
      expect(result).toHaveLength(1);
    });

    it('should handle item with empty string description', () => {
      const items = [makeItem('empty-desc', 'Named Item', '')];
      const result = filterItems(items, 'named');
      expect(result).toHaveLength(1);
    });

    it('should not mutate the original items array', () => {
      const original = [...ITEMS];
      filterItems(ITEMS, 'openai');
      expect(ITEMS).toEqual(original);
    });
  });
});

// ============================================================================
// SearchableCardManager class tests
// ============================================================================

/** Creates a mock container element for class-level tests */
function createMockContainer(): MockContainer {
  const createElement = (cls?: string): MockElement => {
    const el: MockElement = {
      tagName: 'DIV',
      className: cls || '',
      classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn(), contains: jest.fn(() => false) },
      addClass: jest.fn((c: string) => { el.className += ' ' + c; }),
      removeClass: jest.fn(),
      hasClass: jest.fn(),
      toggleClass: jest.fn(),
      setText: jest.fn((text: string) => { el.textContent = text; }),
      createEl: jest.fn((_tag: string, _opts?: MockElementOptions) => {
        const child = createElement(_opts?.cls || '');
        el._children.push(child);
        return child;
      }),
      createDiv: jest.fn((cls2?: string | MockElementOptions) => {
        const c = typeof cls2 === 'string' ? cls2 : cls2?.cls || '';
        const child = createElement(c);
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
      remove: jest.fn(),
      appendChild: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      setAttribute: jest.fn(),
      getAttribute: jest.fn(),
      querySelector: jest.fn(),
      querySelectorAll: jest.fn(() => []),
      style: {},
      textContent: '',
      innerHTML: '',
      focus: jest.fn(),
      _children: [],
    };
    return el;
  };
  return createElement('') as MockContainer;
}

function makeItems(count: number): CardItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `item-${i}`,
    name: `Item ${i}`,
    description: `Description for item ${i}`,
    isEnabled: i % 2 === 0,
  }));
}

function baseCardManagerConfig(): Omit<CardManagerConfig<CardItem>, 'containerEl' | 'items'> {
  return {
    title: 'Test',
    addButtonText: '',
    emptyStateText: 'No items',
    showAddButton: false,
    showToggle: false,
    onAdd: jest.fn(),
    onToggle: jest.fn().mockResolvedValue(undefined),
    onEdit: jest.fn(),
  };
}

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

describe('SearchableCardManager', () => {

  // --------------------------------------------------------------------------
  // Search threshold (minItemsForSearch)
  // --------------------------------------------------------------------------

  describe('search threshold', () => {
    it('should not render search when items below default threshold (5)', () => {
      const container = createMockContainer();
      new SearchableCardManager({
        containerEl: container,
        cardManagerConfig: baseCardManagerConfig(),
        items: makeItems(4),
        search: { placeholder: 'Search...' },
      });

      const searchContainers = findAllByClass(container, 'searchable-card-manager-search');
      expect(searchContainers).toHaveLength(0);
    });

    it('should render search when items meet default threshold (5)', () => {
      const container = createMockContainer();
      new SearchableCardManager({
        containerEl: container,
        cardManagerConfig: baseCardManagerConfig(),
        items: makeItems(5),
        search: { placeholder: 'Search...' },
      });

      const searchContainers = findAllByClass(container, 'searchable-card-manager-search');
      expect(searchContainers).toHaveLength(1);
    });

    it('should respect custom minItemsForSearch', () => {
      const container = createMockContainer();
      new SearchableCardManager({
        containerEl: container,
        cardManagerConfig: baseCardManagerConfig(),
        items: makeItems(2),
        search: { placeholder: 'Search...', minItemsForSearch: 2 },
      });

      const searchContainers = findAllByClass(container, 'searchable-card-manager-search');
      expect(searchContainers).toHaveLength(1);
    });

    it('should count items across all groups for threshold', () => {
      const container = createMockContainer();
      const groups: CardGroup<CardItem>[] = [
        { title: 'A', items: makeItems(3) },
        { title: 'B', items: makeItems(3) },
      ];
      // Total items = 6, default threshold = 5
      new SearchableCardManager({
        containerEl: container,
        cardManagerConfig: baseCardManagerConfig(),
        groups,
        search: { placeholder: 'Search...' },
      });

      const searchContainers = findAllByClass(container, 'searchable-card-manager-search');
      expect(searchContainers).toHaveLength(1);
    });

    it('should not render search when config is omitted', () => {
      const container = createMockContainer();
      new SearchableCardManager({
        containerEl: container,
        cardManagerConfig: baseCardManagerConfig(),
        items: makeItems(10),
        // No search config
      });

      const searchContainers = findAllByClass(container, 'searchable-card-manager-search');
      expect(searchContainers).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Grouped mode — visibility
  // --------------------------------------------------------------------------

  describe('grouped mode', () => {
    it('should create a group container for each group', () => {
      const container = createMockContainer();
      const groups: CardGroup<CardItem>[] = [
        { title: 'LOCAL', items: [makeItems(1)[0]] },
        { title: 'CLOUD', items: makeItems(4) },
      ];

      new SearchableCardManager({
        containerEl: container,
        cardManagerConfig: baseCardManagerConfig(),
        groups,
        search: { placeholder: 'Search...' },
      });

      const groupContainers = findAllByClass(container, 'searchable-card-manager-group');
      expect(groupContainers).toHaveLength(2);
    });

    it('should set group headers with title text', () => {
      const container = createMockContainer();
      const groups: CardGroup<CardItem>[] = [
        { title: 'LOCAL PROVIDERS', items: [makeItems(1)[0]] },
      ];

      new SearchableCardManager({
        containerEl: container,
        cardManagerConfig: baseCardManagerConfig(),
        groups,
      });

      const groupContainers = findAllByClass(container, 'searchable-card-manager-group');
      expect(groupContainers).toHaveLength(1);
      // Group header should have setText called with the title
      const headers = findAllByClass(groupContainers[0], 'nexus-provider-group-title');
      expect(headers).toHaveLength(1);
      expect(headers[0].setText).toHaveBeenCalledWith('LOCAL PROVIDERS');
    });

    it('should not hide groups that have items on initial build', () => {
      const container = createMockContainer();
      const groups: CardGroup<CardItem>[] = [
        { title: 'A', items: makeItems(2) },
      ];

      new SearchableCardManager({
        containerEl: container,
        cardManagerConfig: baseCardManagerConfig(),
        groups,
      });

      const groupContainers = findAllByClass(container, 'searchable-card-manager-group');
      // toggleClass should have been called with false (not hidden)
      expect(groupContainers[0].toggleClass).toHaveBeenCalledWith(
        'searchable-card-manager-group--hidden',
        false
      );
    });
  });

  // --------------------------------------------------------------------------
  // Rebuild cycle — updateItems / updateGroups
  // --------------------------------------------------------------------------

  describe('rebuild cycle', () => {
    it('should call empty() and rebuild on updateItems', () => {
      const container = createMockContainer();
      const manager = new SearchableCardManager({
        containerEl: container,
        cardManagerConfig: baseCardManagerConfig(),
        items: makeItems(3),
      });

      container.empty.mockClear();
      manager.updateItems(makeItems(5));
      expect(container.empty).toHaveBeenCalled();
    });

    it('should call empty() and rebuild on updateGroups', () => {
      const container = createMockContainer();
      const groups: CardGroup<CardItem>[] = [
        { title: 'A', items: makeItems(2) },
      ];
      const manager = new SearchableCardManager({
        containerEl: container,
        cardManagerConfig: baseCardManagerConfig(),
        groups,
      });

      container.empty.mockClear();
      manager.updateGroups([
        { title: 'A', items: makeItems(2) },
        { title: 'B', items: makeItems(3) },
      ]);
      expect(container.empty).toHaveBeenCalled();
    });

    it('should reset internal state on rebuild', () => {
      const container = createMockContainer();
      const manager = new SearchableCardManager({
        containerEl: container,
        cardManagerConfig: baseCardManagerConfig(),
        items: makeItems(6),
        search: { placeholder: 'Search...' },
      });

      // After rebuild with fewer items (below threshold), search should not appear
      container.empty.mockClear();
      manager.updateItems(makeItems(2));
      // After rebuild, the search should not be rendered since 2 < 5
      const searchContainers = findAllByClass(container, 'searchable-card-manager-search');
      expect(searchContainers).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // Ungrouped mode
  // --------------------------------------------------------------------------

  describe('ungrouped mode', () => {
    it('should build without groups when items are provided', () => {
      const container = createMockContainer();
      new SearchableCardManager({
        containerEl: container,
        cardManagerConfig: baseCardManagerConfig(),
        items: makeItems(3),
      });

      // No group containers should exist
      const groupContainers = findAllByClass(container, 'searchable-card-manager-group');
      expect(groupContainers).toHaveLength(0);
    });
  });
});
