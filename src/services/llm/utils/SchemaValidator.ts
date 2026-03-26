/**
 * Schema Validator Utility
 * Location: src/services/llm/utils/SchemaValidator.ts
 *
 * Extracted from BaseAdapter.ts to follow Single Responsibility Principle.
 * Provides basic JSON schema validation for LLM responses and tool parameters.
 *
 * Usage:
 * - Used by BaseAdapter.generateJSON() for response schema validation
 * - Can be used by provider adapters for validating tool schemas
 * - Basic recursive validation - can be enhanced with a proper validator library
 */

export class SchemaValidator {
  private static isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private static isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
  }

  private static isUnknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
  }

  private static getSchemaType(schema: Record<string, unknown>): string | string[] | undefined {
    const schemaType = schema.type;
    if (typeof schemaType === 'string' || this.isStringArray(schemaType)) {
      return schemaType;
    }

    return undefined;
  }

  private static hasProperty(schema: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(schema, key);
  }

  private static addNullToSchemaType(type: string | string[]): string | string[] {
    if (Array.isArray(type)) {
      return type.includes('null') ? type : [...type, 'null'];
    }

    return type === 'null' ? type : [type, 'null'];
  }

  /**
   * Validate data against a JSON schema
   * Basic implementation that checks:
   * - Type matching
   * - Required properties
   * - Nested object validation
   */
  static validateSchema(data: unknown, schema: unknown): boolean {
    // Basic schema validation - could be enhanced with a proper validator
    if (!this.isRecord(schema)) {
      return true;
    }

    const expectedType = this.getSchemaType(schema);
    if (expectedType !== undefined) {
      const actualType = Array.isArray(data) ? 'array' : data === null ? 'null' : typeof data;

      if (Array.isArray(expectedType)) {
        if (!expectedType.includes(actualType)) {
          return false;
        }
      } else if (expectedType !== actualType) {
        return false;
      }
    }

    if (this.isRecord(schema.properties) && this.isRecord(data)) {
      const requiredProperties = Array.isArray(schema.required)
        ? schema.required.filter((key): key is string => typeof key === 'string')
        : [];

      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (requiredProperties.includes(key) && !this.hasProperty(data, key)) {
          return false;
        }

        if (this.hasProperty(data, key) && !this.validateSchema(data[key], propSchema)) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Sanitize JSON Schema for Google's simplified schema format
   * Based on official Gemini API documentation (ai.google.dev/gemini-api/docs/structured-output)
   *
   * SUPPORTED Properties:
   * - Universal: type, title, description
   * - Object: properties, required, additionalProperties
   * - String: enum, format (date-time, date, time)
   * - Number/Integer: enum, minimum, maximum
   * - Array: items, prefixItems, minItems, maxItems
   *
   * NOT SUPPORTED (will be removed):
   * - default, examples, nullable, $ref, $schema, $id, $defs
   * - allOf, anyOf, oneOf, not
   * - minLength, maxLength, pattern
   * - uniqueItems, minProperties, maxProperties
   * - const, if/then/else, and other advanced features
   *
   * Note: For nullable types, use type arrays like ["string", "null"] instead of nullable property
   */
  static sanitizeSchemaForGoogle(schema: unknown): unknown {
    if (!this.isRecord(schema)) {
      return schema;
    }

    // Create a clean copy
    const sanitized: Record<string, unknown> = {};

    // Properties officially supported by Google Gemini (as per docs)
    const allowedProperties = [
      'type',
      'title',
      'description',
      'properties',
      'required',
      'items',
      'prefixItems',
      'enum',
      'format',
      'minimum',
      'maximum',
      'minItems',
      'maxItems',
      'additionalProperties'
    ];

    // Copy allowed properties
    for (const key of allowedProperties) {
      if (this.hasProperty(schema, key)) {
        sanitized[key] = schema[key];
      }
    }

    // Handle nullable types - convert to type array if needed
    if (schema.nullable === true && (typeof sanitized.type === 'string' || Array.isArray(sanitized.type)) && sanitized.type !== 'null') {
      sanitized.type = this.addNullToSchemaType(sanitized.type);
      delete sanitized.nullable; // Remove after converting to type array
    }

    // Recursively sanitize nested properties
    if (this.isRecord(sanitized.properties)) {
      const cleanProps: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(sanitized.properties)) {
        cleanProps[propName] = this.sanitizeSchemaForGoogle(propSchema);
      }
      sanitized.properties = cleanProps;
    }

    // Recursively sanitize array items
    if (sanitized.items) {
      const items = sanitized.items;
      if (this.isUnknownArray(items)) {
        // Convert array of schemas to prefixItems (tuple validation)
        sanitized.prefixItems = items.map((itemSchema: unknown) => this.sanitizeSchemaForGoogle(itemSchema));
        delete sanitized.items;
      } else if (this.isRecord(items)) {
        sanitized.items = this.sanitizeSchemaForGoogle(items);
      }
    }

    // Recursively sanitize prefixItems (tuple schemas)
    if (this.isUnknownArray(sanitized.prefixItems)) {
      const prefixItems = sanitized.prefixItems;
      sanitized.prefixItems = prefixItems.map((itemSchema: unknown) => this.sanitizeSchemaForGoogle(itemSchema));
    }

    // Recursively sanitize additionalProperties if it's a schema
    if (this.isRecord(sanitized.additionalProperties)) {
      sanitized.additionalProperties = this.sanitizeSchemaForGoogle(sanitized.additionalProperties);
    }

    // CRITICAL: Validate required array - remove any properties that don't exist in sanitized.properties
    if (Array.isArray(sanitized.required) && this.isRecord(sanitized.properties)) {
      const properties = sanitized.properties;
      sanitized.required = sanitized.required.filter((propName): propName is string => {
        return typeof propName === 'string' && propName in properties;
      });

      // If required array is now empty, remove it
      if (sanitized.required.length === 0) {
        delete sanitized.required;
      }
    }

    return sanitized;
  }

  /**
   * Validate that a schema is suitable for Google Gemini
   * Returns validation result with error details if invalid
   */
  static validateGoogleSchema(schema: unknown, schemaName?: string): { valid: boolean; error?: string } {
    if (!this.isRecord(schema)) {
      return { valid: false, error: 'Schema must be an object' };
    }

    // Check for unsupported properties at top level
    // Based on official Gemini API documentation - these are explicitly NOT supported
    const unsupportedProperties = [
      'default', 'examples', 'nullable', '$ref', '$schema', '$id', '$defs',
      'allOf', 'anyOf', 'oneOf', 'not',
      'minLength', 'maxLength', 'pattern',
      'uniqueItems',
      'minProperties', 'maxProperties',
      'const', 'if', 'then', 'else'
    ];

    const foundUnsupported = unsupportedProperties.filter(prop => prop in schema);
    if (foundUnsupported.length > 0) {
      return {
        valid: false,
        error: `Schema "${schemaName || 'unknown'}" contains unsupported properties: ${foundUnsupported.join(', ')}`
      };
    }

    // Check schema complexity (deep nesting can cause issues)
    const maxDepth = this.calculateSchemaDepth(schema);
    if (maxDepth > 10) {
      return {
        valid: false,
        error: `Schema "${schemaName || 'unknown'}" is too deeply nested (depth: ${maxDepth}, max: 10)`
      };
    }

    // Recursively validate nested properties
    if (this.isRecord(schema.properties)) {
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        const result = this.validateGoogleSchema(propSchema, `${schemaName}.${propName}`);
        if (!result.valid) {
          return result;
        }
      }
    }

    // Validate array items
    if (this.isRecord(schema.items)) {
      const result = this.validateGoogleSchema(schema.items, `${schemaName}.items`);
      if (!result.valid) {
        return result;
      }
    }

    return { valid: true };
  }

  /**
   * Calculate the maximum depth of a schema (for complexity checking)
   */
  private static calculateSchemaDepth(schema: unknown, currentDepth: number = 0): number {
    if (!this.isRecord(schema) || currentDepth > 20) {
      return currentDepth;
    }

    let maxDepth = currentDepth;

    // Check nested properties
    if (this.isRecord(schema.properties)) {
      for (const propSchema of Object.values(schema.properties)) {
        const depth = this.calculateSchemaDepth(propSchema, currentDepth + 1);
        maxDepth = Math.max(maxDepth, depth);
      }
    }

    // Check array items
    if (this.isRecord(schema.items)) {
      const depth = this.calculateSchemaDepth(schema.items, currentDepth + 1);
      maxDepth = Math.max(maxDepth, depth);
    }

    // Check additionalProperties
    if (this.isRecord(schema.additionalProperties)) {
      const depth = this.calculateSchemaDepth(schema.additionalProperties, currentDepth + 1);
      maxDepth = Math.max(maxDepth, depth);
    }

    return maxDepth;
  }
}
