/**
 * Location: src/types/schema/JSONSchemaTypes.ts
 *
 * JSON Schema Types
 * Provides type-safe schema definitions for tool parameters and results
 *
 * Relationships:
 * - Used by: All BaseTool implementations for getParameterSchema() and getResultSchema()
 * - Used by: ToolManager for schema validation and documentation
 * - Used by: MCP connector for type-safe schema generation
 */

export type JSONSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';

/**
 * Base JSON Schema interface
 * Note: `type` accepts `string` to handle TypeScript's inference of literal types in object literals
 */
export interface JSONSchemaBase {
  type?: JSONSchemaType | JSONSchemaType[] | string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  $ref?: string;
  /** Index signature for Record<string, unknown> compatibility */
  [key: string]: unknown;
}

export interface JSONSchemaString extends JSONSchemaBase {
  type: 'string';
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: 'date' | 'date-time' | 'email' | 'uri' | 'uuid' | string;
}

export interface JSONSchemaNumber extends JSONSchemaBase {
  type: 'number' | 'integer';
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
}

export interface JSONSchemaBoolean extends JSONSchemaBase {
  type: 'boolean';
}

export interface JSONSchemaArray extends JSONSchemaBase {
  type: 'array';
  items?: JSONSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

export interface JSONSchemaObject extends JSONSchemaBase {
  type: 'object';
  properties?: Record<string, JSONSchema>;
  required?: string[];
  additionalProperties?: boolean | JSONSchema;
  patternProperties?: Record<string, JSONSchema>;
}

export interface JSONSchemaNull extends JSONSchemaBase {
  type: 'null';
}

export type JSONSchema =
  | JSONSchemaString
  | JSONSchemaNumber
  | JSONSchemaBoolean
  | JSONSchemaArray
  | JSONSchemaObject
  | JSONSchemaNull
  | JSONSchemaBase;

// Utility type for schema with required type field
export type StrictJSONSchema = Exclude<JSONSchema, JSONSchemaBase>;

// Common schema patterns
export const SchemaPatterns = {
  uuid: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  isoDate: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}',
  filePath: '^[^<>:"|?*]+$'
} as const;
