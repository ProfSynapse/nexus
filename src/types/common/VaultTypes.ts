/**
 * Vault and File System Types
 * Extracted from types.ts for better organization
 */

import { App, TFile } from 'obsidian';

export type VaultNoteOperationOptions = {
  overwrite?: boolean;
} & Record<string, unknown>;

export type VaultNoteMetadata = Record<string, unknown>;

/**
 * Vault manager interface
 */
export interface IVaultManager {
  app: App;
  ensureFolder(path: string): Promise<void>;
  folderExists(path: string): Promise<boolean>;
  createFolder(path: string): Promise<void>;
  createNote(path: string, content: string, options?: VaultNoteOperationOptions): Promise<TFile>;
  readNote(path: string): Promise<string>;
  updateNote(path: string, content: string, options?: VaultNoteOperationOptions): Promise<void>;
  deleteNote(path: string): Promise<void>;
  getNoteMetadata(path: string): Promise<VaultNoteMetadata>;
}

/**
 * Note information structure
 */
export interface NoteInfo {
  path: string;
  name: string;
  extension: string;
  created: number;
  modified: number;
  size: number;
}

/**
 * Folder information structure
 */
export interface FolderInfo {
  path: string;
  name: string;
  children: (FolderInfo | NoteInfo)[];
}

/**
 * Memory Manager Types
 */
export interface WorkspaceSessionInfo {
  id: string;
  name: string;
  workspaceId: string;
  startTime: number;
  endTime?: number;
  isActive: boolean;
  description?: string;
  toolCalls: number;
  tags?: string[];
}

export interface WorkspaceStateInfo {
  id: string;
  name: string;
  workspaceId: string;
  sessionId: string;
  timestamp: number;
  description?: string;
  context?: {
    files: string[];
    traceCount: number;
    tags: string[];
    summary?: string;
  };
}