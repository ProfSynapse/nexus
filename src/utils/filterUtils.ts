/**
 * Utility functions for handling filter patterns in various modes
 */

/**
 * Create a regex from a filter pattern that supports both glob patterns and regex
 * @param pattern The filter pattern (can be glob pattern like "*test*" or regex)
 * @param flags Optional regex flags (default: 'i' for case-insensitive)
 * @returns RegExp object for filtering
 */
export function createFilterRegex(pattern: string, flags = 'i'): RegExp {
  try {
    // First, try to use the pattern as-is (might be a valid regex)
    return new RegExp(pattern, flags);
  } catch {
    // If it fails, treat it as a simple glob pattern and convert to regex
    // Convert glob patterns to regex: * becomes .*, ? becomes .
    const escapedPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars except * and ?
      .replace(/\*/g, '.*') // Convert * to .*
      .replace(/\?/g, '.'); // Convert ? to .
    return new RegExp(escapedPattern, flags);
  }
}

/**
 * Filter an array of items by name using a pattern
 * @param items Array of items with a 'name' property
 * @param pattern Filter pattern (glob or regex)
 * @returns Filtered array
 */
export function filterByName<T extends { name: string }>(items: T[], pattern: string): T[] {
  if (!pattern) return items;
  
  const filterRegex = createFilterRegex(pattern);
  return items.filter(item => filterRegex.test(item.name));
}

/**
 * Filter an array of items by a custom property using a pattern
 * @param items Array of items
 * @param pattern Filter pattern (glob or regex)
 * @param getProperty Function to extract the property to filter by
 * @returns Filtered array
 */
export function filterByProperty<T>(
  items: T[], 
  pattern: string, 
  getProperty: (item: T) => string
): T[] {
  if (!pattern) return items;
  
  const filterRegex = createFilterRegex(pattern);
  return items.filter(item => filterRegex.test(getProperty(item)));
}

/**
 * Standard filter description for use in parameter schemas
 */
export const FILTER_DESCRIPTION = 'Optional filter pattern. Supports glob patterns (* for any chars, ? for single char) or regular expressions. Examples: "*deep*", "test*", ".*regex.*"';
