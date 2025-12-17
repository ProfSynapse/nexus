import { CommonParameters } from '../../types';

/**
 * Arguments for creating a note
 */
export interface CreateNoteParams extends CommonParameters {
  /**
   * Path to the note
   */
  path: string;
  
  /**
   * Content of the note
   */
  content: string;
  
  /**
   * Whether to overwrite if the note already exists
   */
  overwrite?: boolean;
}

/**
 * Result of creating a note
 */
export interface CreateNoteResult {
  /**
   * Path to the note
   */
  path: string;
  
  /**
   * Whether the note was created successfully
   */
  success: boolean;
  
  /**
   * Error message if creation failed
   */
  error?: string;
  
  /**
   * Whether the note already existed
   */
  existed?: boolean;
}

/**
 * Arguments for creating a folder
 */
export interface CreateFolderParams extends CommonParameters {
  /**
   * Path to the folder
   */
  path: string;
}

/**
 * Result of creating a folder
 */
export interface CreateFolderResult {
  /**
   * Path to the folder
   */
  path: string;
  
  /**
   * Whether the folder was created successfully
   */
  success: boolean;
  
  /**
   * Error message if creation failed
   */
  error?: string;
  
  /**
   * Whether the folder already existed
   */
  existed?: boolean;
}

/**
 * Arguments for deleting a note
 */
export interface DeleteNoteParams extends CommonParameters {
  /**
   * Path to the note
   */
  path: string;
}

/**
 * Result of deleting a note
 */
export interface DeleteNoteResult {
  /**
   * Path to the note
   */
  path: string;
  
  /**
   * Whether the note was deleted successfully
   */
  success: boolean;
  
  /**
   * Error message if deletion failed
   */
  error?: string;
}

/**
 * Arguments for deleting a folder
 */
export interface DeleteFolderParams extends CommonParameters {
  /**
   * Path to the folder
   */
  path: string;
  
  /**
   * Whether to delete recursively
   */
  recursive?: boolean;
}

/**
 * Result of deleting a folder
 */
export interface DeleteFolderResult {
  /**
   * Path to the folder
   */
  path: string;
  
  /**
   * Whether the folder was deleted successfully
   */
  success: boolean;
  
  /**
   * Error message if deletion failed
   */
  error?: string;
}

/**
 * Arguments for moving a note
 */
export interface MoveNoteParams extends CommonParameters {
  /**
   * Path to the note
   */
  path: string;
  
  /**
   * New path for the note
   */
  newPath: string;
  
  /**
   * Whether to overwrite if a note already exists at the new path
   */
  overwrite?: boolean;
}

/**
 * Result of moving a note
 */
export interface MoveNoteResult {
  /**
   * Original path of the note
   */
  path: string;
  
  /**
   * New path of the note
   */
  newPath: string;
  
  /**
   * Whether the note was moved successfully
   */
  success: boolean;
  
  /**
   * Error message if move failed
   */
  error?: string;
}

/**
 * Arguments for moving a folder
 */
export interface MoveFolderParams extends CommonParameters {
  /**
   * Path to the folder
   */
  path: string;
  
  /**
   * New path for the folder
   */
  newPath: string;
  
  /**
   * Whether to overwrite if a folder already exists at the new path
   */
  overwrite?: boolean;
}

/**
 * Result of moving a folder
 */
export interface MoveFolderResult {
  /**
   * Original path of the folder
   */
  path: string;
  
  /**
   * New path of the folder
   */
  newPath: string;
  
  /**
   * Whether the folder was moved successfully
   */
  success: boolean;
  
  /**
   * Error message if move failed
   */
  error?: string;
}

/**
 * Arguments for duplicating a note
 */
export interface DuplicateNoteParams extends CommonParameters {
  /**
   * Path to the source note to duplicate
   */
  sourcePath: string;
  
  /**
   * Path for the duplicate note
   */
  targetPath: string;
  
  /**
   * Whether to overwrite if a note already exists at the target path
   */
  overwrite?: boolean;
  
  /**
   * Whether to auto-increment the filename if target exists (e.g., "note copy.md", "note copy 2.md")
   * This takes precedence over overwrite when both are true
   */
  autoIncrement?: boolean;
}

/**
 * Result of duplicating a note
 */
export interface DuplicateNoteResult {
  /**
   * Original path of the source note
   */
  sourcePath: string;
  
  /**
   * Final path of the duplicated note
   */
  targetPath: string;
  
  /**
   * Whether the note was duplicated successfully
   */
  success: boolean;
  
  /**
   * Error message if duplication failed
   */
  error?: string;
  
  /**
   * Whether the target path was auto-incremented due to conflicts
   */
  wasAutoIncremented?: boolean;
  
  /**
   * Whether an existing file was overwritten
   */
  wasOverwritten?: boolean;
}
/**
 * Arguments for opening a note
 */
export interface OpenNoteParams extends CommonParameters {
  /**
   * Path to the note to open
   */
  path: string;
  
  /**
   * Where to open the note
   * - 'tab': Open in new tab
   * - 'split': Open in horizontal split
   * - 'window': Open in new window
   * - 'current': Open in current tab (default)
   */
  mode?: 'tab' | 'split' | 'window' | 'current';
  
  /**
   * Whether to focus the opened note
   */
  focus?: boolean;
}

/**
 * Result of opening a note
 */
export interface OpenNoteResult {
  /**
   * Path to the opened note
   */
  path: string;
  
  /**
   * Whether the note was opened successfully
   */
  success: boolean;
  
  /**
   * Error message if opening failed
   */
  error?: string;
  
  /**
   * Whether the note was opened in the specified mode
   */
  opened: boolean;
  
  /**
   * The actual mode used to open the note
   */
  mode: 'tab' | 'split' | 'window' | 'current';
}

/**
 * Arguments for listing directory contents
 */
export interface ListDirectoryParams extends CommonParameters {
  /**
   * Directory path to list contents from (required)
   * Use empty string (""), "/" or "." for root directory
   */
  path: string;
  
  /**
   * Optional filter pattern for files and folders
   */
  filter?: string;
  
  /**
   * Recursive depth for directory traversal (optional)
   * 0 = only current directory (default)
   * 1 = current directory + immediate subdirectories
   * 2 = current directory + subdirectories + their subdirectories
   * etc.
   */
  depth?: number;
  
  /**
   * Include files in results (default: true). Set false for folders only.
   */
  includeFiles?: boolean;
}

/**
 * Result of listing directory contents
 */
export interface ListDirectoryResult {
  /**
   * Directory path that was listed
   */
  path: string;
  
  /**
   * List of files found
   */
  files: string[];
  
  /**
   * List of folders found
   */
  folders: string[];
  
  /**
   * Whether the operation was successful
   */
  success: boolean;
  
  /**
   * Error message if listing failed
   */
  error?: string;
  
  /**
   * Total number of items found
   */
  totalCount: number;
}
