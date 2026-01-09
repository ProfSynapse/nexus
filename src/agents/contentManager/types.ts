import { CommonParameters, CommonResult } from '../../types';

// ============================================================================
// NEW SIMPLIFIED TOOLS (3 tools replacing 8)
// ============================================================================

/**
 * Params for reading content from a file
 */
export interface ReadParams extends CommonParameters {
  /**
   * Path to the file to read
   */
  path: string;

  /**
   * Start line (1-based), REQUIRED - forces intentional positioning
   */
  startLine: number;

  /**
   * End line (1-based, inclusive). If omitted, reads to end of file.
   */
  endLine?: number;
}

/**
 * Result of reading content from a file
 */
export interface ReadResult extends CommonResult {
  data?: {
    /**
     * Content of the file
     */
    content: string;

    /**
     * Path to the file
     */
    path: string;

    /**
     * Starting line that was read
     */
    startLine: number;

    /**
     * Ending line that was read (if applicable)
     */
    endLine?: number;
  };
}

/**
 * Params for writing content to a file (create or overwrite)
 */
export interface WriteParams extends CommonParameters {
  /**
   * Path to the file to create or overwrite
   */
  path: string;

  /**
   * Content to write to the file
   */
  content: string;

  /**
   * Overwrite if file exists (default: false)
   */
  overwrite?: boolean;
}

/**
 * Result of writing content to a file
 */
export interface WriteResult extends CommonResult {
  // No data returned - LLM already knows the path and content it passed
}

/**
 * Params for updating content in a file (insert, replace, delete, append)
 */
export interface UpdateParams extends CommonParameters {
  /**
   * Path to the file to modify
   */
  path: string;

  /**
   * Content to insert/replace (empty string to delete lines)
   */
  content: string;

  /**
   * Start line (1-based). Use -1 to append to end of file.
   */
  startLine: number;

  /**
   * End line (1-based, inclusive). Omit to INSERT at startLine. Provide to REPLACE range.
   */
  endLine?: number;
}

/**
 * Result of updating content in a file
 */
export interface UpdateResult extends CommonResult {
  /**
   * Net change in line count after the operation.
   * Positive = lines added, Negative = lines removed, Zero = no change.
   * Use this to adjust subsequent line numbers in multi-operation workflows.
   */
  linesDelta?: number;

  /**
   * Recommendations for follow-up actions (uses standard nudge system)
   */
  recommendations?: Array<{ type: string; message: string }>;
}

// ============================================================================
// LEGACY TOOLS (deprecated, kept for backward compatibility)
// ============================================================================

/**
 * Params for reading content from a file
 */
export interface ReadContentParams extends CommonParameters {
  /**
   * Path to the file to read
   */
  filePath: string;

  /**
   * Optional number of lines to read
   */
  limit?: number;

  /**
   * Optional line number to start reading from (1-based)
   */
  offset?: number;

  /**
   * Whether to include line numbers in the output
   */
  includeLineNumbers?: boolean;
}

/**
 * Result of reading content from a file
 */
export interface ReadContentResult extends CommonResult {
  data?: {
    /**
     * Content of the file
     */
    content: string;

    /**
     * Path to the file
     */
    filePath: string;

    /**
     * Whether line numbers are included in the content
     */
    lineNumbersIncluded?: boolean;

    /**
     * Starting line if offset was specified
     */
    startLine?: number;

    /**
     * Ending line if limit was specified
     */
    endLine?: number;
  };
}

/**
 * Params for creating a new file with content
 */
export interface CreateContentParams extends CommonParameters {
  /**
   * Path to the file to create
   */
  filePath: string;
  
  /**
   * Content to write to the file
   */
  content: string;
}

/**
 * Result of creating a file
 */
export interface CreateContentResult extends CommonResult {
  data?: {
    /**
     * Path to the created file
     */
    filePath: string;
    
    /**
     * Creation timestamp
     */
    created: number;
  };
}

/**
 * Params for appending content to a file
 */
export interface AppendContentParams extends CommonParameters {
  /**
   * Path to the file to append to
   */
  filePath: string;
  
  /**
   * Content to append to the file
   */
  content: string;
}

/**
 * Result of appending content to a file
 */
export interface AppendContentResult extends CommonResult {
  data?: {
    /**
     * Path to the file
     */
    filePath: string;
    
    /**
     * Length of the content appended
     */
    appendedLength: number;
    
    /**
     * Total length of the file after appending
     */
    totalLength: number;
  };
}

/**
 * Params for prepending content to a file
 */
export interface PrependContentParams extends CommonParameters {
  /**
   * Path to the file to prepend to
   */
  filePath: string;
  
  /**
   * Content to prepend to the file
   */
  content: string;
}

/**
 * Result of prepending content to a file
 */
export interface PrependContentResult extends CommonResult {
  data?: {
    /**
     * Path to the file
     */
    filePath: string;
    
    /**
     * Length of the content prepended
     */
    prependedLength: number;
    
    /**
     * Total length of the file after prepending
     */
    totalLength: number;
  };
}

/**
 * Params for replacing content in a file
 */
export interface ReplaceContentParams extends CommonParameters {
  /**
   * Path to the file to modify
   */
  filePath: string;
  
  /**
   * Content to replace
   */
  oldContent: string;
  
  /**
   * Content to replace with
   */
  newContent: string;
  
  /**
   * Threshold for fuzzy matching (0.0 to 1.0, where 1.0 is exact match)
   * @default 0.95
   */
  similarityThreshold?: number;
}

/**
 * Result of replacing content in a file
 */
export interface ReplaceContentResult extends CommonResult {
  data?: {
    /**
     * Path to the file
     */
    filePath: string;
    
    /**
     * Number of replacements made
     */
    replacements: number;
  };
}

/**
 * Params for replacing content by line number
 */
export interface ReplaceByLineParams extends CommonParameters {
  /**
   * Path to the file to modify
   */
  filePath: string;
  
  /**
   * Start line number (1-based)
   */
  startLine: number;
  
  /**
   * End line number (1-based, inclusive)
   */
  endLine: number;
  
  /**
   * Content to replace with
   */
  newContent: string;
}

/**
 * Result of replacing content by line number
 */
export interface ReplaceByLineResult extends CommonResult {
  data?: {
    /**
     * Path to the file
     */
    filePath: string;
    
    /**
     * Number of lines replaced
     */
    linesReplaced: number;
  };
}

/**
 * Params for deleting content from a file
 */
export interface DeleteContentParams extends CommonParameters {
  /**
   * Path to the file to modify
   */
  filePath: string;
  
  /**
   * Content to delete
   */
  content: string;
  
  /**
   * Threshold for fuzzy matching (0.0 to 1.0, where 1.0 is exact match)
   * @default 0.95
   */
  similarityThreshold?: number;
}

/**
 * Result of deleting content from a file
 */
export interface DeleteContentResult extends CommonResult {
  data?: {
    /**
     * Path to the file
     */
    filePath: string;
    
    /**
     * Number of deletions made
     */
    deletions: number;
  };
}

/**
 * Params for find and replace operations in a file
 */
export interface FindReplaceContentParams extends CommonParameters {
  /**
   * Path to the file to modify
   */
  filePath: string;
  
  /**
   * Text to find
   */
  findText: string;
  
  /**
   * Text to replace with
   */
  replaceText: string;
  
  /**
   * Whether to replace all occurrences or just the first one
   * @default false
   */
  replaceAll?: boolean;
  
  /**
   * Whether the search should be case sensitive
   * @default true
   */
  caseSensitive?: boolean;
  
  /**
   * Whether to use whole word matching
   * @default false
   */
  wholeWord?: boolean;
}

/**
 * Result of find and replace operations in a file
 */
export interface FindReplaceContentResult extends CommonResult {
  data?: {
    /**
     * Path to the file
     */
    filePath: string;
    
    /**
     * Number of replacements made
     */
    replacements: number;
    
    /**
     * Text that was searched for
     */
    findText: string;
    
    /**
     * Text that was used as replacement
     */
    replaceText: string;
  };
}

/**
 * Content operation type for batch operations
 */
export type ContentOperation = 
  | { type: 'read', params: Omit<ReadContentParams, keyof CommonParameters> }
  | { type: 'create', params: Omit<CreateContentParams, keyof CommonParameters> }
  | { type: 'append', params: Omit<AppendContentParams, keyof CommonParameters> }
  | { type: 'prepend', params: Omit<PrependContentParams, keyof CommonParameters> }
  | { type: 'replace', params: Omit<ReplaceContentParams, keyof CommonParameters> }
  | { type: 'replaceByLine', params: Omit<ReplaceByLineParams, keyof CommonParameters> }
  | { type: 'delete', params: Omit<DeleteContentParams, keyof CommonParameters> }
  | { type: 'findReplace', params: Omit<FindReplaceContentParams, keyof CommonParameters> };

/**
 * Params for batch content operations
 */
export interface BatchContentParams extends CommonParameters {
  /**
   * Array of operations to perform
   */
  operations: ContentOperation[];
}

/**
 * Result of a batch operation
 */
export interface BatchContentResult extends CommonResult {
  data?: {
    /**
     * Array of operation results
     */
    results: Array<{
      /**
       * Whether the operation succeeded
       */
      success: boolean;
      
      /**
       * Error message if success is false
       */
      error?: string;
      
      /**
       * Operation-specific result data
       */
      data?: any;
      
      /**
       * Type of operation
       */
      type: ContentOperation['type'];
      
      /**
       * File path for the operation
       */
      filePath: string;
    }>;
  };
}