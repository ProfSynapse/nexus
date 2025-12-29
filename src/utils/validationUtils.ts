/**
 * Specialized utilities for parameter validation and providing helpful feedback
 */
// import { getErrorMessage } from './errorUtils';

/**
 * Represents a parameter validation error
 */
export interface ValidationError {
    path: string[];    // Path to the parameter that failed validation
    message: string;   // Error message
    code: string;      // Error code for classification
    hint?: string;     // Optional hint for fixing the issue
    expectedType?: string; // Expected type or format
    receivedType?: string; // Received type or format
    allowedValues?: any[]; // Allowed values if enum
}

/**
 * Validates parameters against a schema with enhanced error reporting
 * 
 * @param params Parameters to validate
 * @param schema Schema to validate against
 * @returns An array of validation errors, empty if validation passed
 */
export function validateParams(params: any, schema: any): ValidationError[] {
    const errors: ValidationError[] = [];
    
    // Check if schema exists
    if (!schema || typeof schema !== 'object') {
        return [{
            path: [],
            message: 'Invalid schema: Schema is missing or not an object',
            code: 'INVALID_SCHEMA'
        }];
    }
    
    // Handle required properties
    const requiredProps = Array.isArray(schema.required) ? schema.required : [];
    for (const prop of requiredProps) {
        if (!hasProperty(params, prop)) {
            errors.push({
                path: [prop],
                message: `Missing required parameter: ${prop}`,
                code: 'MISSING_REQUIRED',
                hint: `The parameter '${prop}' is required and must be provided`
            });
        }
    }
    
    // Validate properties that are provided
    if (schema.properties) {
        validateObjectProperties(params, schema.properties, [], errors);
    }
    
    // Check for conditional validations (allOf, anyOf, oneOf)
    if (schema.allOf && Array.isArray(schema.allOf)) {
        validateAllOf(params, schema.allOf, errors);
    }
    
    if (schema.anyOf && Array.isArray(schema.anyOf)) {
        validateAnyOf(params, schema.anyOf, errors);
    }
    
    if (schema.oneOf && Array.isArray(schema.oneOf)) {
        validateOneOf(params, schema.oneOf, errors);
    }
    
    return errors;
}

/**
 * Validate object properties against schema
 */
function validateObjectProperties(
    obj: any, 
    propSchemas: Record<string, unknown>, 
    path: string[], 
    errors: ValidationError[]
): void {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        errors.push({
            path,
            message: 'Expected an object',
            code: 'TYPE_ERROR',
            expectedType: 'object',
            receivedType: Array.isArray(obj) ? 'array' : typeof obj
        });
        return;
    }
    
    for (const [propName, propValue] of Object.entries(obj)) {
        const propPath = [...path, propName];
        const propSchema = propSchemas[propName];
        
        // Skip validation if no schema for this property
        if (!propSchema) continue;
        
        // Validate property value against its schema
        validateProperty(propValue, propSchema, propPath, errors);
    }
}

/**
 * Validate a specific property value against its schema
 */
function validateProperty(
    value: any, 
    schema: any, 
    path: string[], 
    errors: ValidationError[]
): void {
    // Handle type validation
    if (schema.type) {
        const typeValid = validateType(value, schema.type);
        if (!typeValid) {
            errors.push({
                path,
                message: `Invalid type for ${path.join('.')}`,
                code: 'TYPE_ERROR',
                expectedType: schema.type,
                receivedType: Array.isArray(value) ? 'array' : typeof value,
                hint: `This parameter expects ${getTypeDescription(schema.type)}`
            });
            // If type is invalid, skip further validation to avoid cascading errors
            return;
        }
    }
    
    // Handle minimum/maximum for numbers
    if (schema.type === 'number' || schema.type === 'integer') {
        if (schema.minimum !== undefined && value < schema.minimum) {
            errors.push({
                path,
                message: `Value ${value} is less than minimum ${schema.minimum}`,
                code: 'MIN_ERROR',
                hint: `The minimum allowed value is ${schema.minimum}`
            });
        }
        
        if (schema.maximum !== undefined && value > schema.maximum) {
            errors.push({
                path,
                message: `Value ${value} is greater than maximum ${schema.maximum}`,
                code: 'MAX_ERROR',
                hint: `The maximum allowed value is ${schema.maximum}`
            });
        }
    }
    
    // Handle minLength/maxLength for strings
    if (schema.type === 'string') {
        if (schema.minLength !== undefined && value.length < schema.minLength) {
            errors.push({
                path,
                message: `String length ${value.length} is less than minLength ${schema.minLength}`,
                code: 'MIN_LENGTH_ERROR',
                hint: `The string must be at least ${schema.minLength} characters long`
            });
        }
        
        if (schema.maxLength !== undefined && value.length > schema.maxLength) {
            errors.push({
                path,
                message: `String length ${value.length} is greater than maxLength ${schema.maxLength}`,
                code: 'MAX_LENGTH_ERROR',
                hint: `The string must be at most ${schema.maxLength} characters long`
            });
        }
        
        // Handle pattern for strings
        if (schema.pattern) {
            const pattern = new RegExp(schema.pattern);
            if (!pattern.test(value)) {
                errors.push({
                    path,
                    message: `String does not match pattern: ${schema.pattern}`,
                    code: 'PATTERN_ERROR',
                    hint: schema.patternHint || `The string must match the pattern: ${schema.pattern}`
                });
            }
        }
    }
    
    // Handle enum validation
    if (schema.enum && Array.isArray(schema.enum)) {
        if (!schema.enum.includes(value)) {
            errors.push({
                path,
                message: `Value is not one of the allowed values`,
                code: 'ENUM_ERROR',
                allowedValues: schema.enum,
                hint: `Valid values are: ${schema.enum.join(', ')}`
            });
        }
    }
    
    // Handle array validation
    if (schema.type === 'array' && Array.isArray(value)) {
        // Validate minItems/maxItems
        if (schema.minItems !== undefined && value.length < schema.minItems) {
            errors.push({
                path,
                message: `Array length ${value.length} is less than minItems ${schema.minItems}`,
                code: 'MIN_ITEMS_ERROR',
                hint: `The array must have at least ${schema.minItems} items`
            });
        }
        
        if (schema.maxItems !== undefined && value.length > schema.maxItems) {
            errors.push({
                path,
                message: `Array length ${value.length} is greater than maxItems ${schema.maxItems}`,
                code: 'MAX_ITEMS_ERROR',
                hint: `The array must have at most ${schema.maxItems} items`
            });
        }
        
        // Validate array items
        if (schema.items) {
            for (let i = 0; i < value.length; i++) {
                validateProperty(value[i], schema.items, [...path, i.toString()], errors);
            }
        }
    }
    
    // Validate nested object properties
    if (schema.type === 'object' && schema.properties && typeof value === 'object' && value !== null) {
        validateObjectProperties(value, schema.properties, path, errors);
    }
}

/**
 * Validate all conditions in allOf must be satisfied
 */
function validateAllOf(obj: any, schemas: any[], errors: ValidationError[]): void {
    for (const schema of schemas) {
        const subErrors = validateParams(obj, schema);
        errors.push(...subErrors);
    }
}

/**
 * Validate at least one condition in anyOf must be satisfied
 */
function validateAnyOf(obj: any, schemas: any[], errors: ValidationError[]): void {
    const allSubErrors: ValidationError[][] = [];
    
    // Check if at least one schema is valid
    const isValid = schemas.some(schema => {
        const subErrors = validateParams(obj, schema);
        allSubErrors.push(subErrors);
        return subErrors.length === 0;
    });
    
    if (!isValid) {
        // Find the schema with the fewest errors (closest match)
        let minErrorCount = Infinity;
        let bestMatchErrors: ValidationError[] = [];
        
        for (const subErrors of allSubErrors) {
            if (subErrors.length < minErrorCount) {
                minErrorCount = subErrors.length;
                bestMatchErrors = subErrors;
            }
        }
        
        // Add the errors from the closest match
        errors.push({
            path: [],
            message: 'None of the anyOf conditions were satisfied',
            code: 'ANY_OF_ERROR',
            hint: 'The input must satisfy at least one of the specified conditions'
        });
        
        errors.push(...bestMatchErrors);
    }
}

/**
 * Validate exactly one condition in oneOf must be satisfied
 */
function validateOneOf(obj: any, schemas: any[], errors: ValidationError[]): void {
    const validSchemas = schemas.filter(schema => validateParams(obj, schema).length === 0);
    
    if (validSchemas.length === 0) {
        // Same approach as anyOf for providing helpful errors
        let minErrorCount = Infinity;
        let bestMatchErrors: ValidationError[] = [];
        
        for (const schema of schemas) {
            const subErrors = validateParams(obj, schema);
            if (subErrors.length < minErrorCount) {
                minErrorCount = subErrors.length;
                bestMatchErrors = subErrors;
            }
        }
        
        errors.push({
            path: [],
            message: 'None of the oneOf conditions were satisfied',
            code: 'ONE_OF_ERROR',
            hint: 'The input must satisfy exactly one of the specified conditions'
        });
        
        errors.push(...bestMatchErrors);
    } else if (validSchemas.length > 1) {
        errors.push({
            path: [],
            message: `${validSchemas.length} oneOf conditions were satisfied, but exactly one is required`,
            code: 'ONE_OF_MULTIPLE_ERROR',
            hint: 'The input must satisfy exactly one of the specified conditions, not multiple'
        });
    }
}

/**
 * Check if an object has a given property
 */
function hasProperty(obj: any, prop: string): boolean {
    return obj && typeof obj === 'object' && prop in obj;
}

/**
 * Validate a value against a JSON Schema type
 */
function validateType(value: any, type: string | string[]): boolean {
    const types = Array.isArray(type) ? type : [type];
    
    return types.some(t => {
        switch (t) {
            case 'string':
                return typeof value === 'string';
            case 'number':
                return typeof value === 'number' && !isNaN(value);
            case 'integer':
                return typeof value === 'number' && !isNaN(value) && Number.isInteger(value);
            case 'boolean':
                return typeof value === 'boolean';
            case 'array':
                return Array.isArray(value);
            case 'object':
                return typeof value === 'object' && value !== null && !Array.isArray(value);
            case 'null':
                return value === null;
            default:
                return false;
        }
    });
}

/**
 * Get a human-readable description of a type
 */
function getTypeDescription(type: string | string[]): string {
    if (Array.isArray(type)) {
        if (type.length === 1) {
            return getTypeDescription(type[0]);
        }
        
        const descriptions = type.map(t => getTypeDescription(t));
        const lastDesc = descriptions.pop();
        return descriptions.length > 0
            ? `${descriptions.join(', ')} or ${lastDesc}`
            : lastDesc as string;
    }
    
    switch (type) {
        case 'string': return 'a string';
        case 'number': return 'a number';
        case 'integer': return 'an integer';
        case 'boolean': return 'a boolean (true or false)';
        case 'array': return 'an array';
        case 'object': return 'an object';
        case 'null': return 'null';
        default: return `a ${type}`;
    }
}

/**
 * Format validation errors into a detailed error message
 * 
 * @param errors Array of validation errors
 * @returns Formatted error message
 */
export function formatValidationErrors(errors: ValidationError[]): string {
    if (errors.length === 0) {
        return '';
    }
    
    let message = 'Parameter validation failed:\n';
    
    for (const error of errors) {
        const pathStr = error.path.length > 0 ? error.path.join('.') : 'root';
        message += `- ${pathStr}: ${error.message}\n`;
        
        if (error.hint) {
            message += `  Hint: ${error.hint}\n`;
        }
        
        if (error.expectedType && error.receivedType) {
            message += `  Expected ${error.expectedType}, received ${error.receivedType}\n`;
        }
        
        if (error.allowedValues && error.allowedValues.length > 0) {
            const valuesStr = error.allowedValues.map(v => JSON.stringify(v)).join(', ');
            message += `  Allowed values: [${valuesStr}]\n`;
        }
    }
    
    return message;
}

/**
 * Utility function to generate parameter hints from a schema
 * 
 * @param schema The schema to generate hints from
 * @returns Object with parameter hints
 */
export function generateParameterHints(schema: any): Record<string, string> {
    const hints: Record<string, string> = {};
    
    if (!schema || !schema.properties) {
        return hints;
    }
    
    const requiredProps = Array.isArray(schema.required) ? schema.required : [];
    
    for (const [propName, propSchema] of Object.entries<any>(schema.properties)) {
        const isRequired = requiredProps.includes(propName);
        const typeInfo = getTypeInfo(propSchema);
        const constraints = getConstraints(propSchema);
        
        let hint = `${isRequired ? 'Required' : 'Optional'} - ${propSchema.description || 'No description'}`;
        
        if (typeInfo) {
            hint += `\nType: ${typeInfo}`;
        }
        
        if (constraints) {
            hint += `\nConstraints: ${constraints}`;
        }
        
        hints[propName] = hint;
    }
    
    return hints;
}

/**
 * Get type information from a schema property
 */
function getTypeInfo(schema: any): string {
    if (!schema) return '';
    
    if (schema.enum && Array.isArray(schema.enum)) {
        return `One of: [${schema.enum.map((v: unknown) => JSON.stringify(v)).join(', ')}]`;
    }
    
    if (schema.type) {
        if (schema.type === 'array' && schema.items) {
            const itemType = schema.items.type || 'any';
            return `Array of ${itemType}`;
        }
        return Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type;
    }
    
    return '';
}

/**
 * Get constraints information from a schema property
 */
function getConstraints(schema: any): string {
    if (!schema) return '';
    
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
    
    return constraints.join(', ');
}

/**
 * Utility function to enhance a schema with detailed parameter documentation
 * This updates descriptions with type information and required/optional status
 * 
 * @param schema The schema to enhance
 * @returns The enhanced schema
 */
export function enhanceSchemaDocumentation(schema: any): any {
    if (!schema || !schema.properties) {
        return schema;
    }
    
    // Create a deep copy to avoid modifying the original
    const enhancedSchema = JSON.parse(JSON.stringify(schema));
    const requiredProps = Array.isArray(enhancedSchema.required) ? enhancedSchema.required : [];
    
    for (const [propName, propSchema] of Object.entries<any>(enhancedSchema.properties)) {
        const isRequired = requiredProps.includes(propName);
        const requirementMarker = isRequired ? '[REQUIRED] ' : '[OPTIONAL] ';
        
        // Enhance the description with type information
        if (propSchema.description) {
            propSchema.description = requirementMarker + propSchema.description;
        } else {
            propSchema.description = requirementMarker + 'No description provided';
        }
        
        // Add type information to the description
        const typeInfo = getTypeInfo(propSchema);
        if (typeInfo) {
            propSchema.description += ` (${typeInfo})`;
        }
        
        // Add constraints to the description
        const constraints = getConstraints(propSchema);
        if (constraints) {
            propSchema.description += ` [${constraints}]`;
        }
        
        // Recursively enhance nested objects
        if (propSchema.type === 'object' && propSchema.properties) {
            enhancedSchema.properties[propName] = enhanceSchemaDocumentation(propSchema);
        }
        
        // Enhance array item schemas
        if (propSchema.type === 'array' && propSchema.items) {
            if (propSchema.items.type === 'object' && propSchema.items.properties) {
                propSchema.items = enhanceSchemaDocumentation(propSchema.items);
            }
        }
    }
    
    return enhancedSchema;
}