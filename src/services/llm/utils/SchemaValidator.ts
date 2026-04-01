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

interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  prefixItems?: JsonSchema[];
  enum?: unknown[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: JsonSchema | boolean;
  nullable?: boolean;
  default?: unknown;
  examples?: unknown[];
  [key: string]: unknown;
}

export class SchemaValidator {
  private static readonly GOOGLE_ALLOWED_PROPERTIES = [
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
  ] as const;

  /**
   * Validate data against a JSON schema
   * Basic implementation that checks:
   * - Type matching
   * - Required properties
   * - Nested object validation
   */
  static validateSchema(data: unknown, schema: JsonSchema | undefined): boolean {
    // Basic schema validation - could be enhanced with a proper validator
    if (typeof schema !== 'object' || schema === null) {
      return true;
    }

    if (schema.type) {
      const expectedType = schema.type;
      const actualType = Array.isArray(data) ? 'array' : typeof data;

      if (expectedType !== actualType) {
        return false;
      }
    }

    if (schema.properties && typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const objectData = data as Record<string, unknown>;
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (schema.required?.includes(key) && !(key in objectData)) {
          return false;
        }

        if (key in objectData && !this.validateSchema(objectData[key], propSchema)) {
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
  static sanitizeSchemaForGoogle(schema: JsonSchema | undefined): JsonSchema | undefined {
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    // Create a clean copy
    const sanitized: JsonSchema = {};
    const schemaRecord = schema as Record<string, unknown>;
    const sanitizedRecord = sanitized as Record<string, unknown>;

    // Copy allowed properties
    for (const key of SchemaValidator.GOOGLE_ALLOWED_PROPERTIES) {
      if (key in schemaRecord) {
        sanitizedRecord[key] = schemaRecord[key];
      }
    }

    // Handle nullable types - convert to type array if needed
    if (schema.nullable === true && sanitized.type && sanitized.type !== 'null') {
      if (Array.isArray(sanitized.type)) {
        if (!sanitized.type.includes('null')) {
          sanitized.type = [...sanitized.type, 'null'];
        }
      } else {
        sanitized.type = [sanitized.type, 'null'];
      }
      delete sanitized.nullable; // Remove after converting to type array
    }

    // Recursively sanitize nested properties
    let sanitizedProperties = sanitized.properties;
    if (sanitizedProperties && typeof sanitizedProperties === 'object' && !Array.isArray(sanitizedProperties)) {
      const cleanProps: Record<string, JsonSchema> = {};
      for (const [propName, propSchema] of Object.entries(sanitizedProperties)) {
        cleanProps[propName] = (this.sanitizeSchemaForGoogle(propSchema) ?? {});
      }
      sanitizedRecord.properties = cleanProps;
      sanitizedProperties = cleanProps;
    }

    // Recursively sanitize array items
    if (sanitized.items) {
      if (Array.isArray(sanitized.items)) {
        // Convert array of schemas to prefixItems (tuple validation)
        sanitized.prefixItems = sanitized.items.map((itemSchema: JsonSchema) =>
          (this.sanitizeSchemaForGoogle(itemSchema) ?? {})
        );
        delete sanitized.items;
      } else if (typeof sanitized.items === 'object') {
        sanitized.items = this.sanitizeSchemaForGoogle(sanitized.items);
      }
    }

    // Recursively sanitize prefixItems (tuple schemas)
    if (sanitized.prefixItems && Array.isArray(sanitized.prefixItems)) {
      sanitized.prefixItems = sanitized.prefixItems.map((itemSchema: JsonSchema) =>
        (this.sanitizeSchemaForGoogle(itemSchema) ?? {})
      );
    }

    // Recursively sanitize additionalProperties if it's a schema
    if (sanitized.additionalProperties && typeof sanitized.additionalProperties === 'object') {
      sanitized.additionalProperties = this.sanitizeSchemaForGoogle(sanitized.additionalProperties);
    }

    // CRITICAL: Validate required array - remove any properties that don't exist in sanitized.properties
    if (
      sanitized.required &&
      Array.isArray(sanitized.required) &&
      sanitizedProperties &&
      typeof sanitizedProperties === 'object' &&
      !Array.isArray(sanitizedProperties)
    ) {
      sanitized.required = sanitized.required.filter((propName: string) => {
        return propName in sanitizedProperties;
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
  static validateGoogleSchema(schema: JsonSchema | undefined, schemaName?: string): { valid: boolean; error?: string } {
    if (!schema || typeof schema !== 'object') {
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
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        const result = this.validateGoogleSchema(propSchema, `${schemaName}.${propName}`);
        if (!result.valid) {
          return result;
        }
      }
    }

    // Validate array items
    const schemaItems = schema.items;
    if (schemaItems && typeof schemaItems === 'object' && !Array.isArray(schemaItems)) {
      const result = this.validateGoogleSchema(schemaItems, `${schemaName}.items`);
      if (!result.valid) {
        return result;
      }
    }

    return { valid: true };
  }

  /**
   * Calculate the maximum depth of a schema (for complexity checking)
   */
  private static calculateSchemaDepth(schema: JsonSchema | undefined, currentDepth = 0): number {
    if (!schema || typeof schema !== 'object' || currentDepth > 20) {
      return currentDepth;
    }

    let maxDepth = currentDepth;

    // Check nested properties
    if (schema.properties && typeof schema.properties === 'object') {
      for (const propSchema of Object.values(schema.properties)) {
        const depth = this.calculateSchemaDepth(propSchema, currentDepth + 1);
        maxDepth = Math.max(maxDepth, depth);
      }
    }

    // Check array items
    const schemaItems = schema.items;
    if (schemaItems && typeof schemaItems === 'object' && !Array.isArray(schemaItems)) {
      const depth = this.calculateSchemaDepth(schemaItems, currentDepth + 1);
      maxDepth = Math.max(maxDepth, depth);
    }

    // Check additionalProperties
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object' && !Array.isArray(schema.additionalProperties)) {
      const depth = this.calculateSchemaDepth(schema.additionalProperties, currentDepth + 1);
      maxDepth = Math.max(maxDepth, depth);
    }

    return maxDepth;
  }
}
