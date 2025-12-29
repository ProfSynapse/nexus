/**
 * Location: /src/utils/validation/SchemaBlocks.ts
 * Purpose: Provide reusable, composable schema components to reduce schema definition duplication
 * 
 * This utility provides standardized schema building blocks that can be composed together
 * to create consistent JSON schemas across all modes, reducing duplication and ensuring
 * consistent parameter validation and documentation.
 * 
 * Used by: All modes for parameter schema definition via getParameterSchema()
 * Integrates with: JSON Schema, BaseMode.getMergedSchema(), existing schemaUtils
 */

/**
 * JSON Schema type definition
 */
export interface JSONSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  description?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  format?: string;
  examples?: any[];
  items?: JSONSchema;
  enum?: any[];
  oneOf?: JSONSchema[];
  allOf?: JSONSchema[];
  not?: JSONSchema;
  if?: JSONSchema;
  then?: JSONSchema;
  anyOf?: JSONSchema[];
  dependencies?: Record<string, string[]>;
  additionalProperties?: boolean;
  default?: any;
  title?: string;
  
  // Custom extensions for tooling
  'x-sensitive'?: boolean;
  'x-pattern-hint'?: string;
  'x-labels'?: Record<string, string>;
}

/**
 * Schema block options for enhanced configuration
 */
export interface SchemaBlockOptions {
  description: string;
  required?: boolean;
  examples?: string[];
  constraints?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * SchemaBlocks - Composable schema building components for consistent schema creation
 */
export class SchemaBlocks {
  
  /**
   * Create validated string schema with comprehensive constraints
   * 
   * Provides a standardized string schema with common validation constraints
   * and consistent formatting across all modes.
   * 
   * @param options Configuration for the string schema
   * @returns JSON Schema for validated string
   */
  static validatedString(options: {
    description: string;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    patternHint?: string;
    examples?: string[];
    format?: 'email' | 'uri' | 'date-time' | 'password';
    sensitive?: boolean;
    required?: boolean;
  }): JSONSchema {
    const schema: JSONSchema = {
      type: 'string',
      description: options.description
    };

    // Apply length constraints
    if (options.minLength !== undefined) schema.minLength = options.minLength;
    if (options.maxLength !== undefined) schema.maxLength = options.maxLength;
    
    // Apply pattern validation
    if (options.pattern) schema.pattern = options.pattern;
    if (options.format) schema.format = options.format;
    if (options.examples) schema.examples = options.examples;

    // Add metadata for enhanced tooling
    if (options.sensitive) schema['x-sensitive'] = true;
    if (options.patternHint) schema['x-pattern-hint'] = options.patternHint;

    return schema;
  }

  /**
   * Entity name schema with intelligent defaults based on entity type
   * 
   * Provides consistent naming schemas for different entity types with
   * appropriate length limits and character constraints.
   * 
   * @param entityType Type of entity being named
   * @param options Additional configuration options
   * @returns JSON Schema for entity name
   */
  static entityName(entityType: string, options: {
    maxLength?: number;
    allowSpecialChars?: boolean;
    uniqueConstraint?: boolean;
    examples?: string[];
  } = {}): JSONSchema {
    const maxLength = options.maxLength || this.getDefaultMaxLength(entityType);
    const pattern = options.allowSpecialChars 
      ? '^[a-zA-Z0-9\\s\\-_.@#+]+$'
      : '^[a-zA-Z0-9\\s\\-_]+$';
    
    const description = `Name of the ${entityType}${
      options.uniqueConstraint ? ' (must be unique)' : ''
    }`;
    
    const examples = options.examples || this.generateEntityExamples(entityType);

    return this.validatedString({
      description,
      minLength: 1,
      maxLength,
      pattern,
      patternHint: 'Letters, numbers, spaces, hyphens, and underscores allowed',
      examples
    });
  }

  /**
   * Search query schema with context-aware examples and constraints
   * 
   * Provides specialized schemas for different search contexts with appropriate
   * examples and validation rules.
   * 
   * @param context Type of search being performed
   * @param options Additional configuration options
   * @returns JSON Schema for search query
   */
  static searchQuery(context: 'content' | 'files' | 'memory' | 'universal' = 'universal', options: {
    maxLength?: number;
    allowEmpty?: boolean;
    examples?: string[];
  } = {}): JSONSchema {
    const contextExamples = {
      content: ['project planning', 'typescript validation', 'API documentation'],
      files: ['README.md', '*.ts', 'config'],
      memory: ['recent sessions', 'workspace activity', 'tool usage'],
      universal: ['project planning', 'machine learning', 'typescript', 'notes']
    };

    return this.validatedString({
      description: `Search query for ${context} search`,
      minLength: options.allowEmpty ? 0 : 1,
      maxLength: options.maxLength || 1000,
      examples: options.examples || contextExamples[context]
    });
  }

  /**
   * File path schema with Obsidian-specific validation
   * 
   * Provides file path validation appropriate for different file operations
   * with Obsidian-specific constraints and examples.
   * 
   * @param context Type of file operation
   * @param options Additional configuration options
   * @returns JSON Schema for file path
   */
  static filePath(context: 'read' | 'write' | 'search' = 'read', options: {
    allowGlobs?: boolean;
    allowDirectories?: boolean;
    requiredExtension?: string;
    examples?: string[];
  } = {}): JSONSchema {
    const contextDescriptions = {
      read: 'Path to file to read',
      write: 'Path where file will be created or modified',
      search: 'Path to restrict search scope'
    };

    let pattern = '^[^<>:"|?*\\x00-\\x1f]+$'; // Basic file path validation
    if (options.allowGlobs) {
      pattern = '^[^<>:"|\\x00-\\x1f]+$'; // Allow * and ? for globs
    }

    return this.validatedString({
      description: contextDescriptions[context],
      minLength: 1,
      maxLength: 1000,
      pattern,
      patternHint: 'Valid file path without reserved characters',
      examples: options.examples || this.generateFilePathExamples(context, options)
    });
  }

  /**
   * Boolean flag schema with enhanced UX
   * 
   * Provides consistent boolean schemas with user-friendly labels
   * and clear descriptions.
   * 
   * @param purpose What the boolean flag controls
   * @param defaultValue Default value for the flag
   * @param options Additional configuration
   * @returns JSON Schema for boolean flag
   */
  static booleanFlag(purpose: string, defaultValue: boolean = false, options: {
    description?: string;
    trueLabel?: string;
    falseLabel?: string;
  } = {}): JSONSchema {
    const schema: JSONSchema = {
      type: 'boolean',
      description: options.description || `Whether to ${purpose}`,
      default: defaultValue
    };

    // Add labels for better UX in tools
    if (options.trueLabel && options.falseLabel) {
      schema['x-labels'] = {
        true: options.trueLabel,
        false: options.falseLabel
      };
    }

    return schema;
  }

  /**
   * Numeric limit schema with context-aware defaults
   * 
   * Provides number schemas with appropriate defaults and constraints
   * based on the usage context.
   * 
   * @param context Usage context for the numeric value
   * @param options Additional configuration options
   * @returns JSON Schema for numeric limit
   */
  static numericLimit(context: 'search' | 'list' | 'batch' = 'search', options: {
    defaultValue?: number;
    minimum?: number;
    maximum?: number;
    allowUnlimited?: boolean;
    description?: string;
  } = {}): JSONSchema {
    const contextDefaults = {
      search: { default: 10, min: 1, max: 50 },
      list: { default: 20, min: 1, max: 100 },
      batch: { default: 10, min: 1, max: 1000 }
    };

    const defaults = contextDefaults[context];
    const defaultValue = options.defaultValue ?? defaults.default;
    const minimum = options.minimum ?? defaults.min;
    const maximum = options.maximum ?? defaults.max;

    const schema: JSONSchema = {
      type: 'number',
      description: options.description || `Maximum number of results (default: ${defaultValue})`,
      minimum,
      default: defaultValue
    };

    if (!options.allowUnlimited) {
      schema.maximum = maximum;
    }

    return schema;
  }

  /**
   * Enum selection schema with descriptive options
   * 
   * Creates enum schemas with clear descriptions and examples
   * for better user experience.
   * 
   * @param values Array of allowed values
   * @param options Configuration options
   * @returns JSON Schema for enum selection
   */
  static enumSelection<T extends string>(values: T[], options: {
    description: string;
    default?: T;
    labels?: Record<T, string>;
  }): JSONSchema {
    const schema: JSONSchema = {
      type: 'string',
      enum: values,
      description: options.description
    };

    if (options.default) {
      schema.default = options.default;
    }

    if (options.labels) {
      schema['x-labels'] = options.labels;
    }

    return schema;
  }

  /**
   * Advanced schema composition with validation rules
   * 
   * Composes multiple schema blocks together with advanced JSON Schema
   * features like conditional validation and mutual exclusivity.
   * 
   * @param blocks Schema blocks to compose
   * @param options Composition configuration
   * @returns Composed JSON Schema
   */
  static composeSchema(blocks: Record<string, JSONSchema>, options: {
    required?: string[];
    conditionalRequired?: Record<string, string[]>;
    mutuallyExclusive?: string[][];
    dependencies?: Record<string, string[]>;
    additionalProperties?: boolean;
    title?: string;
    description?: string;
  } = {}): JSONSchema {
    const schema: JSONSchema = {
      type: 'object',
      properties: blocks,
      additionalProperties: options.additionalProperties ?? false
    };

    if (options.title) schema.title = options.title;
    if (options.description) schema.description = options.description;
    if (options.required) schema.required = options.required;

    // Advanced JSON Schema features
    if (options.conditionalRequired) {
      schema.allOf = [];
      for (const [condition, requiredFields] of Object.entries(options.conditionalRequired)) {
        schema.allOf.push({
          if: { properties: { [condition]: { const: true } } },
          then: { required: requiredFields }
        });
      }
    }

    if (options.mutuallyExclusive && options.mutuallyExclusive.length > 0) {
      schema.not = {
        anyOf: options.mutuallyExclusive.map(group => ({
          allOf: group.map(field => ({ required: [field] }))
        }))
      };
    }

    if (options.dependencies) {
      schema.dependencies = options.dependencies;
    }

    return schema;
  }

  /**
   * Context field schema for ToolContext (memory/goal/constraints format)
   *
   * Provides standardized schema for context fields used in session tracking
   * and tool operation context. Uses the new format instead of legacy
   * sessionDescription/sessionMemory/subgoal fields.
   *
   * @param fieldType Type of context field (memory, goal, or constraints)
   * @param options Configuration options
   * @returns JSON Schema for context field
   */
  static contextField(fieldType: 'memory' | 'goal' | 'constraints', options: {
    minLength?: number;
    maxLength?: number;
    examples?: string[];
  } = {}): JSONSchema {
    const fieldConfig = {
      memory: {
        desc: 'Essence of conversation so far (1-3 sentences)',
        defaultMin: 5,
        defaultMax: 500,
        examples: ['Implemented validation utilities, now working on schema blocks', 'Fixed search bug, testing results', 'User wants to organize their notes into workspaces']
      },
      goal: {
        desc: 'Current objective (1-3 sentences)',
        defaultMin: 5,
        defaultMax: 300,
        examples: ['Implement validation standardization', 'Fix search performance issues', 'Create workspace for research project']
      },
      constraints: {
        desc: 'Optional rules/limits to follow (1-3 sentences)',
        defaultMin: 0,
        defaultMax: 300,
        examples: ['Only modify files in the src/ folder', 'Keep response under 500 words', 'Use TypeScript patterns from existing codebase']
      }
    };

    const config = fieldConfig[fieldType];

    return this.validatedString({
      description: config.desc,
      minLength: options.minLength ?? config.defaultMin,
      maxLength: options.maxLength || config.defaultMax,
      examples: options.examples || config.examples
    });
  }

  // Helper methods for generating defaults and examples

  /**
   * Get default maximum length for different entity types
   * 
   * @param entityType Type of entity
   * @returns Default maximum length
   */
  private static getDefaultMaxLength(entityType: string): number {
    const defaults: Record<string, number> = {
      prompt: 100,
      session: 150,
      workspace: 100,
      file: 255,
      description: 500,
      content: 5000,
      query: 1000,
      name: 100
    };
    return defaults[entityType] || 100;
  }

  /**
   * Generate appropriate examples for entity types
   * 
   * @param entityType Type of entity
   * @returns Array of example names
   */
  private static generateEntityExamples(entityType: string): string[] {
    const examples: Record<string, string[]> = {
      prompt: ['Code Reviewer', 'Technical Writer', 'Research Assistant'],
      session: ['Daily Planning', 'Code Review Session', 'Research Notes'],
      workspace: ['Project Alpha', 'Research Workspace', 'Client Work'],
      file: ['README.md', 'config.json', 'main.ts'],
      query: ['search term', 'project planning', 'typescript validation'],
      name: ['My Item', 'New Entity', 'Custom Name']
    };
    return examples[entityType] || [`My ${entityType}`, `${entityType} name`];
  }

  /**
   * Generate file path examples based on context and options
   * 
   * @param context File operation context
   * @param options Configuration options
   * @returns Array of example file paths
   */
  private static generateFilePathExamples(
    context: 'read' | 'write' | 'search',
    options: any
  ): string[] {
    const baseExamples = {
      read: ['path/to/file.md', 'notes/daily-notes.txt', 'docs/README.md'],
      write: ['output/result.md', 'generated/summary.txt', 'exports/data.json'],
      search: ['notes/', 'projects/**/*.md', 'docs/']
    };

    let examples = baseExamples[context];

    if (options.allowGlobs) {
      examples = [...examples, '**/*.ts', 'src/**/*', '*.{md,txt}'];
    }

    if (options.requiredExtension) {
      examples = examples.map(ex => 
        ex.includes('.') ? ex : `${ex}.${options.requiredExtension}`
      );
    }

    return examples;
  }
}