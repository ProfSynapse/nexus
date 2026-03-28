import { App, TFile, TFolder } from 'obsidian';
import { sanitizePath } from './pathUtils';

/**
 * Directory tree node representing a file or folder
 */
export interface DirectoryTreeNode {
  /**
   * Name of the file or folder
   */
  name: string;
  
  /**
   * Full path to the file or folder
   */
  path: string;
  
  /**
   * Type of the node
   */
  type: 'file' | 'folder';
  
  /**
   * Children nodes (only for folders)
   */
  children?: DirectoryTreeNode[];
  
  /**
   * File extension (only for files)
   */
  extension?: string;
  
  /**
   * Last modified timestamp (only for files)
   */
  lastModified?: number;
  
  /**
   * File size in bytes (only for files)
   */
  size?: number;
  
  
  /**
   * Whether this file is in the workspace's related files
   */
  isRelatedFile?: boolean;
  
  /**
   * Description from frontmatter (only for markdown files)
   */
  description?: string;
}

/**
 * Options for building directory trees
 */
export interface DirectoryTreeOptions {
  /**
   * Maximum depth to traverse (0 = unlimited)
   */
  maxDepth?: number;
  
  /**
   * Whether to include file metadata (size, lastModified)
   */
  includeMetadata?: boolean;
  
  /**
   * File extensions to include (empty = all files)
   */
  includeExtensions?: string[];
  
  /**
   * File extensions to exclude
   */
  excludeExtensions?: string[];
  
  
  /**
   * List of related files to mark
   */
  relatedFiles?: string[];
}

interface DirectoryTreeStats {
  totalFiles: number;
  totalFolders: number;
  relatedFiles: number;
  maxDepth: number;
}

/**
 * Build a directory tree structure for a given root folder
 */
export class DirectoryTreeBuilder {
  private app: App;
  
  constructor(app: App) {
    this.app = app;
  }
  
  /**
   * Build a directory tree for the given root path
   */
  async buildTree(rootPath: string, options: DirectoryTreeOptions = {}): Promise<DirectoryTreeNode | null> {
    const normalizedRootPath = sanitizePath(rootPath, false);
    
    // Get the root folder
    const rootFolder = this.app.vault.getAbstractFileByPath(normalizedRootPath);
    
    if (!rootFolder) {
      return null;
    }
    
    if (rootFolder instanceof TFile) {
      // If root is a file, return a single file node
      return await this.buildFileNode(rootFolder, options);
    }
    
    if (rootFolder instanceof TFolder) {
      // Build tree from folder
      return await this.buildFolderNode(rootFolder, options, 0);
    }
    
    return null;
  }
  
  /**
   * Build a directory tree for multiple root paths
   */
  async buildMultiTree(rootPaths: string[], options: DirectoryTreeOptions = {}): Promise<DirectoryTreeNode[]> {
    const trees: DirectoryTreeNode[] = [];
    
    for (const rootPath of rootPaths) {
      const tree = await this.buildTree(rootPath, options);
      if (tree) {
        trees.push(tree);
      }
    }
    
    return trees;
  }
  
  /**
   * Build a flattened list of all files in the directory tree
   */
  async getFileList(rootPath: string, options: DirectoryTreeOptions = {}): Promise<string[]> {
    const tree = await this.buildTree(rootPath, options);
    if (!tree) {
      return [];
    }
    
    return this.flattenTree(tree);
  }
  
  /**
   * Build a node for a file
   */
  private async buildFileNode(file: TFile, options: DirectoryTreeOptions): Promise<DirectoryTreeNode> {
    const node: DirectoryTreeNode = {
      name: file.name,
      path: file.path,
      type: 'file',
      extension: file.extension
    };
    
    // Add metadata if requested
    if (options.includeMetadata && file.stat) {
      node.lastModified = file.stat.mtime;
    }
    
    
    // Mark as related file if in the list
    if (options.relatedFiles && options.relatedFiles.includes(file.path)) {
      node.isRelatedFile = true;
    }
    
    // Get description from frontmatter for markdown files
    if (file.extension === 'md') {
      try {
        const content = await this.app.vault.read(file);
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        
        if (frontmatterMatch) {
          const frontmatter = frontmatterMatch[1];
          // Look for description field
          const descMatch = frontmatter.match(/description\s*:\s*["']?([^\n"']+)["']?/);
          if (descMatch) {
            node.description = descMatch[1].trim();
          }
        }
      } catch {
        // Ignore errors reading file
      }
    }
    
    return node;
  }
  
  /**
   * Build a node for a folder
   */
  private async buildFolderNode(
    folder: TFolder, 
    options: DirectoryTreeOptions, 
    currentDepth: number
  ): Promise<DirectoryTreeNode> {
    const node: DirectoryTreeNode = {
      name: folder.name,
      path: folder.path,
      type: 'folder',
      children: []
    };
    
    // Check depth limit
    if (options.maxDepth && currentDepth >= options.maxDepth) {
      return node;
    }
    
    // Process children
    for (const child of folder.children) {
      if (child instanceof TFile) {
        // Filter by extensions if specified
        if (options.includeExtensions && options.includeExtensions.length > 0) {
          if (!options.includeExtensions.includes(child.extension)) {
            continue;
          }
        }
        
        if (options.excludeExtensions && options.excludeExtensions.includes(child.extension)) {
          continue;
        }
        
        const fileNode = await this.buildFileNode(child, options);
        node.children!.push(fileNode);
      } else if (child instanceof TFolder) {
        const folderNode = await this.buildFolderNode(child, options, currentDepth + 1);
        node.children!.push(folderNode);
      }
    }
    
    // Sort children: folders first by name, then files by last modified (newest first)
    node.children!.sort((a, b) => {
      // Folders come before files
      if (a.type === 'folder' && b.type === 'file') return -1;
      if (a.type === 'file' && b.type === 'folder') return 1;
      
      // Between folders, sort alphabetically
      if (a.type === 'folder' && b.type === 'folder') {
        return a.name.localeCompare(b.name);
      }
      
      // Between files, sort by last modified (newest first)
      if (a.type === 'file' && b.type === 'file') {
        const aTime = a.lastModified || 0;
        const bTime = b.lastModified || 0;
        return bTime - aTime;
      }
      
      return 0;
    });
    
    return node;
  }
  
  
  /**
   * Flatten a directory tree into a list of file paths
   */
  private flattenTree(node: DirectoryTreeNode): string[] {
    const files: string[] = [];
    
    if (node.type === 'file') {
      files.push(node.path);
    } else if (node.children) {
      for (const child of node.children) {
        files.push(...this.flattenTree(child));
      }
    }
    
    return files;
  }
  
  /**
   * Find a node in the tree by path
   */
  findNodeByPath(tree: DirectoryTreeNode, targetPath: string): DirectoryTreeNode | null {
    const normalizedTarget = sanitizePath(targetPath, false);
    const normalizedCurrentPath = sanitizePath(tree.path, false);
    
    if (normalizedCurrentPath === normalizedTarget) {
      return tree;
    }
    
    if (tree.children) {
      for (const child of tree.children) {
        const found = this.findNodeByPath(child, targetPath);
        if (found) {
          return found;
        }
      }
    }
    
    return null;
  }
  
  
  /**
   * Get all files marked as related files in the tree
   */
  getRelatedFiles(tree: DirectoryTreeNode): string[] {
    const relatedFiles: string[] = [];
    
    if (tree.type === 'file' && tree.isRelatedFile) {
      relatedFiles.push(tree.path);
    } else if (tree.children) {
      for (const child of tree.children) {
        relatedFiles.push(...this.getRelatedFiles(child));
      }
    }
    
    return relatedFiles;
  }
}

/**
 * Utility functions for working with directory trees
 */
export class DirectoryTreeUtils {
  /**
   * Convert a directory tree to a simple text representation
   */
  static treeToText(tree: DirectoryTreeNode, indent = ''): string {
    let result = '';

    const prefix = tree.type === 'folder' ? '📁 ' : '📄 ';
    const keyIndicator = '';
    const relatedIndicator = tree.isRelatedFile ? ' 🔗' : '';
    const description = tree.description ? ` - ${tree.description}` : '';
    
    result += `${indent}${prefix}${tree.name}${keyIndicator}${relatedIndicator}${description}\n`;
    
    if (tree.children && tree.children.length > 0) {
      for (let i = 0; i < tree.children.length; i++) {
        const isChildLast = i === tree.children.length - 1;
        const childIndent = indent + (isChildLast ? '    ' : '│   ');
        const childPrefix = isChildLast ? '└── ' : '├── ';
        
        result += `${indent}${childPrefix}`;
        result += this.treeToText(tree.children[i], childIndent).substring(indent.length + 4);
      }
    }
    
    return result;
  }
  
  /**
   * Get statistics about a directory tree
   */
  static getTreeStats(tree: DirectoryTreeNode): DirectoryTreeStats {
    const stats: DirectoryTreeStats = {
      totalFiles: 0,
      totalFolders: 0,
      relatedFiles: 0,
      maxDepth: 0
    };
    
    this.calculateStats(tree, stats, 0);
    
    return stats;
  }
  
  private static calculateStats(
    node: DirectoryTreeNode, 
    stats: DirectoryTreeStats,
    currentDepth: number
  ): void {
    stats.maxDepth = Math.max(stats.maxDepth, currentDepth);
    
    if (node.type === 'file') {
      stats.totalFiles++;
      if (node.isRelatedFile) stats.relatedFiles++;
    } else {
      stats.totalFolders++;
    }
    
    if (node.children) {
      for (const child of node.children) {
        this.calculateStats(child, stats, currentDepth + 1);
      }
    }
  }
}