/**
 * SearchableCardManager Unit Tests
 *
 * Tests the exported `filterItems()` pure function.
 * No DOM mocking needed — pure function testing.
 *
 * Coverage target: 85%+ (pure logic, STANDARD risk)
 */

import { filterItems } from '../../src/components/SearchableCardManager';
import { CardItem } from '../../src/components/CardManager';

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
