/**
 * Utility functions for JSON operations
 * This module provides reusable functions for handling JSON-related operations
 * across the codebase, particularly focused on safe stringification and array parsing.
 */

/**
 * Safely stringify an object, handling circular references
 * @param obj - Object to stringify
 * @returns JSON string representation of the object
 * 
 * Example:
 * ```ts
 * const obj = { a: 1 };
 * obj.self = obj; // circular reference
 * console.log(safeStringify(obj)); // {"a":1,"self":"[Circular Reference]"}
 * ```
 */
export function safeStringify(obj: any): string {
    const seen = new WeakSet();
    return JSON.stringify(obj, (_, value) => {
        if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
                return '[Circular Reference]';
            }
            seen.add(value);
        }
        return value;
    }, 2);
}

/**
 * Parse string representations of JSON arrays in arguments
 * Handles cases where array parameters might be passed as stringified JSON
 * 
 * @param args - Arguments object to parse
 * @returns Parsed arguments object with proper arrays
 * 
 * Example:
 * ```ts
 * const args = { paths: '["file1.txt","file2.txt"]' };
 * const parsed = parseJsonArrays(args);
 * console.log(parsed.paths); // ['file1.txt', 'file2.txt']
 * ```
 */
export function parseJsonArrays(args: any): any {
    if (!args || typeof args !== 'object') {
        return args;
    }

    const result: any = {};
    
    // Process each property in the arguments object
    for (const [key, value] of Object.entries(args)) {
        // Check if the value is a string that looks like a JSON array
        if (typeof value === 'string' &&
            value.trim().startsWith('[') &&
            value.trim().endsWith(']')) {
            try {
                // Attempt to parse the string as JSON
                result[key] = JSON.parse(value);
            } catch (error) {
                // If parsing fails, keep the original string value
                result[key] = value;
            }
        } else {
            // For non-array strings or other types, keep the original value
            result[key] = value;
        }
    }
    
    return result;
}
