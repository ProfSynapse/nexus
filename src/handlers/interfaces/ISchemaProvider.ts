/**
 * Location: src/handlers/interfaces/ISchemaProvider.ts
 *
 * Interface for schema enhancement providers that can enhance tool schemas
 * with additional properties, validation rules, and improvements.
 * Used by SchemaEnhancementService to provide modular enhancement capabilities.
 */

import { JSONSchema } from '../../types/schema/JSONSchemaTypes';

/**
 * Extended JSON Schema type that supports conditional validation and additional properties.
 * Used for enhanced schemas that may include allOf, anyOf, oneOf constructs.
 */
export interface EnhancedJSONSchema extends Record<string, unknown> {
    type?: string;
    properties?: Record<string, JSONSchema | EnhancedJSONSchema>;
    required?: string[];
    description?: string;
    allOf?: Array<{ if?: Record<string, unknown>; then?: Record<string, unknown>; [key: string]: unknown }>;
    anyOf?: Array<JSONSchema | EnhancedJSONSchema>;
    oneOf?: Array<JSONSchema | EnhancedJSONSchema>;
    enum?: unknown[];
    default?: unknown;
    examples?: unknown[];
}

export interface ISchemaProvider {
    /**
     * The name of this schema provider
     */
    readonly name: string;
    
    /**
     * The description of what this provider enhances
     */
    readonly description: string;
    
    /**
     * Check if this provider can enhance the given tool schema
     * @param toolName The name of the tool to check
     * @param baseSchema The base schema to potentially enhance
     * @returns Promise<boolean> true if this provider can enhance the schema
     */
    canEnhance(toolName: string, baseSchema: EnhancedJSONSchema): Promise<boolean>;

    /**
     * Enhance the given schema with additional properties or validation
     * @param toolName The name of the tool being enhanced
     * @param baseSchema The base schema to enhance
     * @returns Promise<EnhancedJSONSchema> The enhanced schema
     */
    enhanceSchema(toolName: string, baseSchema: EnhancedJSONSchema): Promise<EnhancedJSONSchema>;
    
    /**
     * Get the priority of this provider (higher numbers = higher priority)
     * Used to determine the order of enhancement application
     * @returns number The priority value
     */
    getPriority(): number;
}