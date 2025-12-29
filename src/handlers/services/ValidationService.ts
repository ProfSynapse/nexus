import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { IValidationService, BatchOperation } from '../interfaces/IRequestHandlerServices';
import { EnhancedJSONSchema } from '../interfaces/ISchemaProvider';
import { JSONSchema } from '../../types/schema/JSONSchemaTypes';
import { validateParams, formatValidationErrors, ValidationError } from '../../utils/validationUtils';
import { generateHintsForErrors } from '../../utils/parameterHintUtils';
import { getErrorMessage } from '../../utils/errorUtils';
import { logger } from '../../utils/logger';
import { smartNormalizePath, normalizePath, OperationType } from '../../utils/pathUtils';

export class ValidationService implements IValidationService {
    async validateToolParams(params: Record<string, unknown>, schema?: JSONSchema | EnhancedJSONSchema, toolName?: string): Promise<Record<string, unknown>> {
        const enhancedParams = { ...params };
        
        // Apply smart path normalization to common path parameters before validation
        this.normalizePathParameters(enhancedParams, toolName);
        
        if (schema) {
            await this.validateAgainstSchema(enhancedParams, schema);
        }
        
        if (enhancedParams.operations && Array.isArray(enhancedParams.operations)) {
            await this.validateBatchOperations(enhancedParams.operations as BatchOperation[]);
        }

        if (enhancedParams.paths !== undefined) {
            // Cast to unknown first then to string[] - validateBatchPaths will handle type checking
            await this.validateBatchPaths(enhancedParams.paths as string[]);
        }
        
        return enhancedParams;
    }

    async validateSessionId(sessionId: string): Promise<string> {
        if (!sessionId || typeof sessionId !== 'string') {
            throw new McpError(
                ErrorCode.InvalidParams,
                'Session ID must be a non-empty string'
            );
        }
        return sessionId;
    }

    /**
     * Apply appropriate path normalization based on operation type
     */
    private normalizePathParameters(params: Record<string, unknown>, toolName?: string): void {
        const operationType = this.getOperationType(toolName);
        
        // Common path parameter names used across modes
        const pathParameterNames = [
            'path',           
            'filePath',       
            'sourcePath',     
            'targetPath',     
            'newPath',        
            'oldPath'         
        ];

        // Normalize individual path parameters
        for (const paramName of pathParameterNames) {
            if (params[paramName] && typeof params[paramName] === 'string') {
                if (operationType === 'DIRECTORY') {
                    // Directory operations: only basic normalization
                    params[paramName] = normalizePath(params[paramName]);
                } else {
                    // Note operations: smart normalization with .md extension
                    params[paramName] = smartNormalizePath(params[paramName], false, operationType);
                }
            }
        }

        // Handle array of paths (like in batch operations)
        if (params.paths && Array.isArray(params.paths)) {
            params.paths = (params.paths as unknown[]).map((path: unknown) => {
                if (typeof path === 'string') {
                    return operationType === 'DIRECTORY'
                        ? normalizePath(path)
                        : smartNormalizePath(path, false, operationType);
                }
                return path;
            });
        }

        // Handle file paths in operations arrays (batch operations)
        // These typically need NOTE operation type for .md extension handling
        if (params.operations && Array.isArray(params.operations)) {
            (params.operations as unknown[]).forEach((operation: unknown) => {
                if (operation && typeof operation === 'object' && 'params' in operation) {
                    const op = operation as { type?: string; params: Record<string, unknown> };
                    // For batch operations, we need to check the operation type
                    const opType = op.type || '';
                    this.normalizePathParameters(op.params, opType);
                }
            });
        }

        // Handle contextFiles arrays in agent operations (these are typically file paths)
        if (params.contextFiles && Array.isArray(params.contextFiles)) {
            params.contextFiles = (params.contextFiles as unknown[]).map((path: unknown) =>
                typeof path === 'string' ? smartNormalizePath(path, false, 'NOTE') : path
            );
        }

        // Handle filepaths arrays (used in some prompt execution modes - these are typically file paths)
        if (params.filepaths && Array.isArray(params.filepaths)) {
            params.filepaths = (params.filepaths as unknown[]).map((path: unknown) =>
                typeof path === 'string' ? smartNormalizePath(path, false, 'NOTE') : path
            );
        }
    }

    /**
     * Determine operation type based on tool name
     */
    private getOperationType(toolName?: string): OperationType {
        if (!toolName) return 'GENERIC';

        // Directory operations - never need .md extension
        const directoryOperations = [
            'list', 'createFolder', 'archive', 'move', 'copy'
        ];

        // Note operations - need .md extension when no extension present
        const noteOperations = [
            'open', 'readContent', 'createContent', 'appendContent',
            'prependContent', 'replaceContent', 'deleteContent'
        ];

        if (directoryOperations.some(op => toolName.includes(op) || toolName.endsWith(op))) {
            return 'DIRECTORY';
        }

        if (noteOperations.some(op => toolName.includes(op) || toolName.endsWith(op))) {
            return 'NOTE';
        }

        return 'GENERIC';
    }

    async validateBatchOperations(operations: BatchOperation[]): Promise<void> {
        const batchErrors: ValidationError[] = [];

        operations.forEach((operation: BatchOperation, index: number) => {
            const op = operation as unknown as Record<string, unknown>;
            if (!op || typeof op !== 'object') {
                batchErrors.push({
                    path: ['operations', index.toString()],
                    message: 'Operation must be an object',
                    code: 'TYPE_ERROR',
                    expectedType: 'object',
                    receivedType: typeof op
                });
                return;
            }

            if (!op.type) {
                batchErrors.push({
                    path: ['operations', index.toString(), 'type'],
                    message: "Missing 'type' property",
                    code: 'MISSING_REQUIRED',
                    hint: "Each operation must have a 'type' property that specifies the operation type"
                });
            }

            if (!op.params) {
                batchErrors.push({
                    path: ['operations', index.toString(), 'params'],
                    message: "Missing 'params' property",
                    code: 'MISSING_REQUIRED',
                    hint: "Each operation must have a 'params' object containing the operation parameters"
                });
            } else if (typeof op.params !== 'object' || Array.isArray(op.params)) {
                batchErrors.push({
                    path: ['operations', index.toString(), 'params'],
                    message: "'params' must be an object",
                    code: 'TYPE_ERROR',
                    expectedType: 'object',
                    receivedType: Array.isArray(op.params) ? 'array' : typeof op.params
                });
            }
        });
        
        if (batchErrors.length > 0) {
            throw new McpError(
                ErrorCode.InvalidParams,
                formatValidationErrors(batchErrors)
            );
        }
    }

    async validateBatchPaths(paths: string[]): Promise<void> {
        const pathErrors: ValidationError[] = [];
        const pathsValue = paths as unknown;

        if (!Array.isArray(pathsValue)) {
            if (typeof pathsValue === 'string' &&
                pathsValue.trim().startsWith('[') &&
                pathsValue.trim().endsWith(']')) {
                try {
                    JSON.parse(pathsValue);
                    return;
                } catch (error) {
                    pathErrors.push({
                        path: ['paths'],
                        message: `Failed to parse 'paths' as JSON array: ${getErrorMessage(error)}`,
                        code: 'PARSE_ERROR',
                        expectedType: 'array',
                        receivedType: 'string',
                        hint: "The 'paths' parameter must be a valid JSON array of strings. Example: [\"file1.md\", \"file2.md\"]"
                    });
                }
            } else {
                pathErrors.push({
                    path: ['paths'],
                    message: `'paths' must be an array, not a ${typeof pathsValue}`,
                    code: 'TYPE_ERROR',
                    expectedType: 'array',
                    receivedType: typeof pathsValue,
                    hint: "The 'paths' parameter must be an array of strings. Example: [\"Projects/file.md\"] or [\"/\"] for root"
                });
            }
        } else {
            (pathsValue as unknown[]).forEach((path: unknown, index: number) => {
                if (typeof path !== 'string') {
                    pathErrors.push({
                        path: ['paths', index.toString()],
                        message: `Path at index ${index} must be a string, not ${typeof path}`,
                        code: 'TYPE_ERROR',
                        expectedType: 'string',
                        receivedType: typeof path,
                        hint: "Each path in the 'paths' array must be a string representing a file or folder path"
                    });
                }
            });
        }
        
        if (pathErrors.length > 0) {
            const errorMessage = formatValidationErrors(pathErrors);
            throw new McpError(
                ErrorCode.InvalidParams,
                `❌ Path Validation Failed\n\n${errorMessage}\n\n💡 Tip: Paths should be an array of strings like ["/"] or ["folder/file.md"]`
            );
        }
    }

    private async validateAgainstSchema(params: Record<string, unknown>, schema: JSONSchema | EnhancedJSONSchema): Promise<void> {
        const validationErrors = validateParams(params, schema);
        if (validationErrors.length > 0) {
            logger.systemLog('DEBUG: Validation errors found:', JSON.stringify(validationErrors, null, 2));
            logger.systemLog('DEBUG: Schema used for validation:', JSON.stringify(schema, null, 2));
            logger.systemLog('DEBUG: Params being validated:', JSON.stringify(params, null, 2));
            
            const hints = generateHintsForErrors(validationErrors, schema);
            
            for (const error of validationErrors) {
                if (error.path.length === 1) {
                    const paramName = error.path[0];
                    if (hints[paramName] && !error.hint) {
                        error.hint = hints[paramName];
                    }
                }
            }
            
            // Type guard for schema with required and properties fields
            const schemaWithRequired = schema as { required?: string[]; properties?: Record<string, unknown> };
            if (schemaWithRequired.required && Array.isArray(schemaWithRequired.required) && schemaWithRequired.required.length > 0) {
                const missingRequiredParams = schemaWithRequired.required.filter(
                    (param: string) => !params[param]
                );

                if (missingRequiredParams.length > 0) {
                    const missingParamsInfo = missingRequiredParams.map((param: string) => {
                        const paramSchema = schemaWithRequired.properties?.[param] as Record<string, unknown> | undefined;
                        let info = `- ${param}: ${(paramSchema?.description as string) || 'No description'}`;

                        if (paramSchema?.type) {
                            info += ` (type: ${paramSchema.type as string})`;
                        }

                        const examples = paramSchema?.examples as unknown[] | undefined;
                        if (examples && examples.length > 0) {
                            const exampleValue = typeof examples[0] === 'string'
                                ? `"${examples[0]}"`
                                : JSON.stringify(examples[0]);
                            info += `\n  Example: ${exampleValue}`;
                        }

                        return info;
                    }).join('\n\n');

                    const requiredParamsMessage = `\n\n📋 Missing Required Parameters:\n${missingParamsInfo}\n\n💡 Tip: Check the tool schema to see what parameters are needed.`;

                    throw new McpError(
                        ErrorCode.InvalidParams,
                        `❌ Validation Failed\n\n` + formatValidationErrors(validationErrors) + requiredParamsMessage
                    );
                }
            }
            
            throw new McpError(
                ErrorCode.InvalidParams,
                `❌ Validation Failed\n\n` + formatValidationErrors(validationErrors) + `\n\n💡 Check parameter types and required fields.`
            );
        }
    }
}
