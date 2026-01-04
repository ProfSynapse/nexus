/**
 * Utilities for generating helpful parameter hints for users
 */
import { getErrorMessage } from './errorUtils';
import { ValidationError } from './validationUtils';

/**
 * Parameter hint for a specific tool parameter
 */
export interface ParameterHint {
    name: string;
    description: string;
    type: string;
    required: boolean;
    defaultValue?: unknown;
    constraints?: string;
    example?: unknown;
}

/**
 * Contextual help for a specific tool
 */
export interface ToolHelp {
    toolName: string;
    description: string;
    parameters: ParameterHint[];
    examples?: {
        description: string;
        parameters: Record<string, unknown>;
    }[];
}

/**
 * @deprecated Use ToolHelp instead
 */
export type ModeHelp = ToolHelp;

/**
 * Generate structured parameter hints from a JSON schema
 * 
 * @param schema JSON schema to generate hints from
 * @returns Parameter hints for all properties in the schema
 */
export function generateStructuredHints(schema: any): ParameterHint[] {
    if (!schema || !schema.properties || typeof schema.properties !== 'object') {
        return [];
    }
    
    const requiredProps = Array.isArray(schema.required) ? schema.required : [];
    const hints: ParameterHint[] = [];
    
    for (const [propName, propSchema] of Object.entries<any>(schema.properties)) {
        if (!propSchema) continue;
        
        const hint: ParameterHint = {
            name: propName,
            description: propSchema.description || 'No description provided',
            type: getTypeFromSchema(propSchema),
            required: requiredProps.includes(propName)
        };
        
        // Add default value if present
        if (propSchema.default !== undefined) {
            hint.defaultValue = propSchema.default;
        }
        
        // Add constraints if present
        const constraints = getConstraintsFromSchema(propSchema);
        if (constraints) {
            hint.constraints = constraints;
        }
        
        // Add example if present
        if (propSchema.examples && propSchema.examples.length > 0) {
            hint.example = propSchema.examples[0];
        } else if (propSchema.example !== undefined) {
            hint.example = propSchema.example;
        }
        
        hints.push(hint);
    }
    
    // Sort required parameters first, then alphabetically
    return hints.sort((a, b) => {
        if (a.required && !b.required) return -1;
        if (!a.required && b.required) return 1;
        return a.name.localeCompare(b.name);
    });
}

/**
 * Generate structured tool help from a tool's schema and metadata
 *
 * @param toolName Name of the tool
 * @param description Description of the tool
 * @param schema JSON schema for the tool parameters
 * @param examples Optional examples of tool usage
 * @returns Structured help object for the tool
 */
export function generateToolHelp(
    toolName: string,
    description: string,
    schema: Record<string, unknown>,
    examples?: { description: string; parameters: Record<string, unknown> }[]
): ToolHelp {
    return {
        toolName,
        description,
        parameters: generateStructuredHints(schema),
        examples
    };
}

/**
 * Format tool help into a user-friendly string
 *
 * @param help Structured tool help object
 * @returns Formatted help string
 */
export function formatToolHelp(help: ToolHelp): string {
    let output = `## ${help.toolName}\n\n${help.description}\n\n### Parameters:\n\n`;

    for (const param of help.parameters) {
        output += `**${param.name}**${param.required ? ' (Required)' : ' (Optional)'}: ${param.description}\n`;
        output += `- Type: ${param.type}\n`;

        if (param.defaultValue !== undefined) {
            output += `- Default: ${JSON.stringify(param.defaultValue)}\n`;
        }

        if (param.constraints) {
            output += `- Constraints: ${param.constraints}\n`;
        }

        if (param.example !== undefined) {
            output += `- Example: ${JSON.stringify(param.example)}\n`;
        }

        output += '\n';
    }

    if (help.examples && help.examples.length > 0) {
        output += `### Examples:\n\n`;

        for (const example of help.examples) {
            output += `#### ${example.description}\n\`\`\`json\n${JSON.stringify(example.parameters, null, 2)}\n\`\`\`\n\n`;
        }
    }

    return output;
}

/**
 * @deprecated Use formatToolHelp instead
 */
export function formatModeHelp(help: ToolHelp): string {
    return formatToolHelp(help);
}

/**
 * Generate parameter hints for validation errors
 * 
 * @param errors Array of validation errors
 * @param schema JSON schema used for validation
 * @returns Array of hint strings for each error
 */
export function generateHintsForErrors(errors: ValidationError[], schema: any): Record<string, string> {
    const hints: Record<string, string> = {};
    
    if (!schema || !schema.properties) {
        return hints;
    }
    
    for (const error of errors) {
        // Skip errors already having hints
        if (error.hint) continue;
        
        // Get parameter name from the error path
        const paramName = error.path.length > 0 ? error.path[0] : '';
        if (!paramName || typeof paramName !== 'string') continue;
        
        // Get schema for this parameter
        const paramSchema = schema.properties[paramName];
        if (!paramSchema) continue;
        
        // Generate hint based on error code
        let hint = '';
        
        switch (error.code) {
            case 'MISSING_REQUIRED':
                hint = `Required parameter. ${paramSchema.description || ''}`;
                break;
                
            case 'TYPE_ERROR':
                hint = `Must be ${getTypeFromSchema(paramSchema)}. ${paramSchema.description || ''}`;
                break;
                
            case 'ENUM_ERROR':
                if (paramSchema.enum && Array.isArray(paramSchema.enum)) {
                    hint = `Must be one of: ${paramSchema.enum.map((v: unknown) => JSON.stringify(v)).join(', ')}`;
                }
                break;
                
            case 'MIN_ERROR':
                hint = `Must be at least ${paramSchema.minimum}`;
                break;
                
            case 'MAX_ERROR':
                hint = `Must be at most ${paramSchema.maximum}`;
                break;
                
            case 'MIN_LENGTH_ERROR':
                hint = `Must be at least ${paramSchema.minLength} characters long`;
                break;
                
            case 'MAX_LENGTH_ERROR':
                hint = `Must be at most ${paramSchema.maxLength} characters long`;
                break;
                
            case 'PATTERN_ERROR':
                hint = `Must match pattern: ${paramSchema.pattern}`;
                break;
                
            default:
                // For unknown error codes, provide general parameter information
                hint = paramSchema.description || '';
                if (paramSchema.type) {
                    hint += ` Type: ${getTypeFromSchema(paramSchema)}.`;
                }
        }
        
        if (hint) {
            hints[paramName] = hint;
        }
    }
    
    return hints;
}

/**
 * Extract type information from a schema property
 * 
 * @param schema Schema property to extract type from
 * @returns String representation of the property type
 */
function getTypeFromSchema(schema: any): string {
    if (!schema) return 'any';
    
    if (schema.enum && Array.isArray(schema.enum)) {
        return `enum (${schema.enum.map((v: unknown) => JSON.stringify(v)).join(', ')})`;
    }
    
    if (schema.type) {
        if (schema.type === 'array' && schema.items) {
            const itemType = schema.items.type || 'any';
            return `array of ${itemType}`;
        }
        
        if (schema.type === 'object' && schema.properties) {
            const propNames = Object.keys(schema.properties);
            if (propNames.length === 0) {
                return 'object';
            }
            return `object with properties: ${propNames.join(', ')}`;
        }
        
        return Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type;
    }
    
    return 'any';
}

/**
 * Extract constraints from a schema property
 * 
 * @param schema Schema property to extract constraints from
 * @returns String representation of constraints, or undefined if none
 */
function getConstraintsFromSchema(schema: any): string | undefined {
    if (!schema) return undefined;
    
    const constraints: string[] = [];
    
    if (schema.minLength !== undefined) {
        constraints.push(`min length: ${schema.minLength}`);
    }
    
    if (schema.maxLength !== undefined) {
        constraints.push(`max length: ${schema.maxLength}`);
    }
    
    if (schema.pattern) {
        constraints.push(`pattern: ${schema.pattern}`);
    }
    
    if (schema.minimum !== undefined) {
        constraints.push(`min: ${schema.minimum}`);
    }
    
    if (schema.maximum !== undefined) {
        constraints.push(`max: ${schema.maximum}`);
    }
    
    if (schema.minItems !== undefined) {
        constraints.push(`min items: ${schema.minItems}`);
    }
    
    if (schema.maxItems !== undefined) {
        constraints.push(`max items: ${schema.maxItems}`);
    }
    
    return constraints.length > 0 ? constraints.join(', ') : undefined;
}