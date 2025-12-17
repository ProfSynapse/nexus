/**
 * SchemaBuilder - Handles JSON schema generation for batch operations
 * Follows Single Responsibility Principle by focusing only on schema building
 */

/**
 * Service responsible for building JSON schemas for batch content operations
 * Follows SRP by focusing only on schema generation operations
 */
export class SchemaBuilder {
  /**
   * Get parameter schema for batch content mode
   */
  getParameterSchema(): any {
    return {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          description: 'Array of operations to perform',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['read', 'create', 'append', 'prepend', 'replace', 'replaceByLine', 'delete', 'findReplace'],
                description: 'Type of operation'
              },
              params: {
                type: 'object',
                description: 'Operation-specific parameters. IMPORTANT: All operations require a "filePath" parameter.',
                allOf: [
                  this.getReadOperationSchema(),
                  this.getCreateOperationSchema(),
                  this.getAppendPrependOperationSchema(),
                  this.getReplaceOperationSchema(),
                  this.getReplaceByLineOperationSchema(),
                  this.getDeleteOperationSchema(),
                  this.getFindReplaceOperationSchema()
                ]
              }
            },
            required: ['type', 'params']
          }
        },
        workspaceContext: {
          type: 'object',
          description: 'Workspace context for the operation'
        },
        sessionId: {
          type: 'string',
          description: 'Session identifier for tracking'
        },
      },
      required: ['operations']
    };
  }

  /**
   * Get result schema for batch content mode
   */
  getResultSchema(): any {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'Whether the operation succeeded'
        },
        error: {
          type: 'string',
          description: 'Error message if success is false'
        },
        data: {
          type: 'object',
          properties: {
            results: {
              type: 'array',
              description: 'Array of operation results',
              items: this.getResultItemSchema()
            }
          },
          required: ['results']
        },
        workspaceContext: {
          type: 'object',
          properties: {
            workspaceId: {
              type: 'string',
              description: 'ID of the workspace'
            },
            workspacePath: {
              type: 'array',
              items: {
                type: 'string'
              },
              description: 'Path of the workspace'
            },
            activeWorkspace: {
              type: 'boolean',
              description: 'Whether this is the active workspace'
            }
          }
        },
      },
      required: ['success']
    };
  }

  /**
   * Get schema for read operations
   */
  private getReadOperationSchema(): any {
    return {
      if: {
        properties: { 
          "type": { "enum": ["read"] } 
        }
      },
      then: {
        properties: {
          filePath: { type: 'string', description: 'Path to the file to read' },
          limit: { type: 'number', description: 'Optional number of lines to read' },
          offset: { type: 'number', description: 'Optional line number to start reading from (1-based)' },
          includeLineNumbers: { type: 'boolean', description: 'Whether to include line numbers in the output' }
        },
        required: ['filePath']
      }
    };
  }

  /**
   * Get schema for create operations
   */
  private getCreateOperationSchema(): any {
    return {
      if: {
        properties: { 
          "type": { "enum": ["create"] }
        }
      },
      then: {
        properties: {
          filePath: { type: 'string', description: 'Path to the file to create' },
          content: { type: 'string', description: 'Content to write to the file' }
        },
        required: ['filePath', 'content']
      }
    };
  }

  /**
   * Get schema for append/prepend operations
   */
  private getAppendPrependOperationSchema(): any {
    return {
      if: {
        properties: { 
          "type": { "enum": ["append", "prepend"] }
        }
      },
      then: {
        properties: {
          filePath: { type: 'string', description: 'Path to the file to modify' },
          content: { type: 'string', description: 'Content to append/prepend to the file' }
        },
        required: ['filePath', 'content']
      }
    };
  }

  /**
   * Get schema for replace operations
   */
  private getReplaceOperationSchema(): any {
    return {
      if: {
        properties: { 
          "type": { "enum": ["replace"] }
        }
      },
      then: {
        properties: {
          filePath: { type: 'string', description: 'Path to the file to modify' },
          oldContent: { type: 'string', description: 'Content to replace' },
          newContent: { type: 'string', description: 'Content to replace with' },
          similarityThreshold: { 
            type: 'number', 
            description: 'Threshold for fuzzy matching (0.0 to 1.0, where 1.0 is exact match)',
            default: 0.95,
            minimum: 0.0,
            maximum: 1.0
          }
        },
        required: ['filePath', 'oldContent', 'newContent']
      }
    };
  }

  /**
   * Get schema for replace by line operations
   */
  private getReplaceByLineOperationSchema(): any {
    return {
      if: {
        properties: { 
          "type": { "enum": ["replaceByLine"] }
        }
      },
      then: {
        properties: {
          filePath: { type: 'string', description: 'Path to the file to modify' },
          startLine: { type: 'number', description: 'Start line number (1-based)' },
          endLine: { type: 'number', description: 'End line number (1-based, inclusive)' },
          newContent: { type: 'string', description: 'Content to replace with' }
        },
        required: ['filePath', 'startLine', 'endLine', 'newContent']
      }
    };
  }

  /**
   * Get schema for delete operations
   */
  private getDeleteOperationSchema(): any {
    return {
      if: {
        properties: { 
          "type": { "enum": ["delete"] }
        }
      },
      then: {
        properties: {
          filePath: { type: 'string', description: 'Path to the file to modify' },
          content: { type: 'string', description: 'Content to delete' },
          similarityThreshold: { 
            type: 'number', 
            description: 'Threshold for fuzzy matching (0.0 to 1.0, where 1.0 is exact match)',
            default: 0.95,
            minimum: 0.0,
            maximum: 1.0
          }
        },
        required: ['filePath', 'content']
      }
    };
  }

  /**
   * Get schema for find/replace operations
   */
  private getFindReplaceOperationSchema(): any {
    return {
      if: {
        properties: { 
          "type": { "enum": ["findReplace"] }
        }
      },
      then: {
        properties: {
          filePath: { type: 'string', description: 'Path to the file to modify' },
          findText: { type: 'string', description: 'Text to find' },
          replaceText: { type: 'string', description: 'Text to replace with' },
          replaceAll: { 
            type: 'boolean', 
            description: 'Whether to replace all occurrences or just the first one',
            default: false
          },
          caseSensitive: { 
            type: 'boolean', 
            description: 'Whether the search should be case sensitive',
            default: true
          },
          wholeWord: { 
            type: 'boolean', 
            description: 'Whether to use whole word matching',
            default: false
          }
        },
        required: ['filePath', 'findText', 'replaceText']
      }
    };
  }

  /**
   * Get schema for result items
   */
  private getResultItemSchema(): any {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'Whether the operation succeeded'
        },
        error: {
          type: 'string',
          description: 'Error message if success is false'
        },
        data: {
          type: 'object',
          description: 'Operation-specific result data'
        },
        type: {
          type: 'string',
          description: 'Type of operation'
        },
        filePath: {
          type: 'string',
          description: 'File path for the operation'
        }
      },
      required: ['success', 'type', 'filePath']
    };
  }

  /**
   * Get schema validation statistics
   */
  getSchemaStats(): {
    parameterSchemaProperties: number;
    resultSchemaProperties: number;
    supportedOperations: string[];
  } {
    return {
      parameterSchemaProperties: Object.keys(this.getParameterSchema().properties).length,
      resultSchemaProperties: Object.keys(this.getResultSchema().properties).length,
      supportedOperations: ['read', 'create', 'append', 'prepend', 'replace', 'replaceByLine', 'delete', 'findReplace']
    };
  }
}