import { App, TFile, TFolder } from 'obsidian';
import { smartNormalizePath, normalizePath } from '../../../utils/pathUtils';

/**
 * Utility class for file operations
 */
export class FileOperations {
  /**
   * Create a note
   * @param app Obsidian app instance
   * @param path Path to the note
   * @param content Content of the note
   * @param overwrite Whether to overwrite if the note already exists
   * @returns Promise that resolves with the created file and whether it already existed
   * @throws Error if creation fails
   */
  static async createNote(
    app: App,
    path: string,
    content: string,
    overwrite = false
  ): Promise<{ file: TFile; existed: boolean }> {
    // Apply smart normalization for note operations (includes .md extension handling)
    const normalizedPath = smartNormalizePath(path, false, 'NOTE');
    
    // Check if the file already exists
    const existingFile = app.vault.getAbstractFileByPath(normalizedPath);
    if (existingFile) {
      if (existingFile instanceof TFile) {
        if (overwrite) {
          // Overwrite the existing file
          await app.vault.modify(existingFile, content);
          return { file: existingFile, existed: true };
        } else {
          throw new Error(`File already exists: ${path}`);
        }
      } else {
        throw new Error(`Path exists but is not a file: ${path}`);
      }
    }
    
    // Ensure the parent folder exists
    const folderPath = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'));
    if (folderPath) {
      await FileOperations.ensureFolder(app, folderPath);
    }
    
    // Create the file
    const file = await app.vault.create(normalizedPath, content);
    return { file, existed: false };
  }
  
  /**
   * Create a folder
   * @param app Obsidian app instance
   * @param path Path to the folder
   * @returns Promise that resolves with whether the folder already existed
   * @throws Error if creation fails
   */
  static async createFolder(app: App, path: string): Promise<boolean> {
    // Normalize path to remove any leading slash
    const normalizedPath = normalizePath(path);
    
    // Check if the folder already exists
    const existingFolder = app.vault.getAbstractFileByPath(normalizedPath);
    if (existingFolder) {
      if (existingFolder instanceof TFolder) {
        return true;
      } else {
        throw new Error(`Path exists but is not a folder: ${path}`);
      }
    }
    
    // Create the folder
    await app.vault.createFolder(normalizedPath);
    return false;
  }
  
  /**
   * Ensure a folder exists
   * @param app Obsidian app instance
   * @param path Path to the folder
   * @returns Promise that resolves when the folder exists
   */
  static async ensureFolder(app: App, path: string): Promise<void> {
    // Normalize path to remove any leading slash
    const normalizedPath = normalizePath(path);
    
    const folders = normalizedPath.split('/').filter((p: string) => p.length > 0);
    let currentPath = '';
    
    for (const folder of folders) {
      currentPath += folder;
      
      try {
        await FileOperations.createFolder(app, currentPath);
      } catch {
        // Ignore errors if the folder already exists
      }
      
      currentPath += '/';
    }
  }
  
  /**
   * Delete a note
   * @param app Obsidian app instance
   * @param path Path to the note
   * @returns Promise that resolves when the note is deleted
   * @throws Error if deletion fails
   */
  static async deleteNote(app: App, path: string): Promise<void> {
    // Normalize path to remove any leading slash
    const normalizedPath = normalizePath(path);
    
    const file = app.vault.getAbstractFileByPath(normalizedPath);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }
    
    if (!(file instanceof TFile)) {
      throw new Error(`Path is not a file: ${path}`);
    }
    
    await app.fileManager.trashFile(file);
  }
  
  /**
   * Delete a folder
   * @param app Obsidian app instance
   * @param path Path to the folder
   * @param recursive Whether to delete recursively
   * @returns Promise that resolves when the folder is deleted
   * @throws Error if deletion fails
   */
  static async deleteFolder(app: App, path: string, recursive = false): Promise<void> {
    // Normalize path to remove any leading slash
    const normalizedPath = normalizePath(path);
    
    const folder = app.vault.getAbstractFileByPath(normalizedPath);
    if (!folder) {
      throw new Error(`Folder not found: ${path}`);
    }
    
    if (!(folder instanceof TFolder)) {
      throw new Error(`Path is not a folder: ${path}`);
    }
    
    if (!recursive && folder.children.length > 0) {
      throw new Error(`Folder is not empty: ${path}`);
    }
    
    await app.fileManager.trashFile(folder);
  }
  
  /**
   * Move a note
   * @param app Obsidian app instance
   * @param path Path to the note
   * @param newPath New path for the note
   * @param overwrite Whether to overwrite if a note already exists at the new path
   * @returns Promise that resolves when the note is moved
   * @throws Error if move fails
   */
  static async moveNote(
    app: App,
    path: string,
    newPath: string,
    overwrite = false
  ): Promise<void> {
    // Normalize paths to remove any leading slashes
    const normalizedPath = normalizePath(path);
    const normalizedNewPath = normalizePath(newPath);
    
    const file = app.vault.getAbstractFileByPath(normalizedPath);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }
    
    if (!(file instanceof TFile)) {
      throw new Error(`Path is not a file: ${path}`);
    }
    
    // Check if the destination already exists
    const existingFile = app.vault.getAbstractFileByPath(normalizedNewPath);
    if (existingFile) {
      if (overwrite) {
        await app.fileManager.trashFile(existingFile);
      } else {
        throw new Error(`Destination already exists: ${newPath}`);
      }
    }
    
    // Ensure the parent folder exists
    const folderPath = normalizedNewPath.substring(0, normalizedNewPath.lastIndexOf('/'));
    if (folderPath) {
      await FileOperations.ensureFolder(app, folderPath);
    }
    
    await app.vault.rename(file, normalizedNewPath);
  }
  
  /**
   * Move a folder
   * @param app Obsidian app instance
   * @param path Path to the folder
   * @param newPath New path for the folder
   * @param overwrite Whether to overwrite if a folder already exists at the new path
   * @returns Promise that resolves when the folder is moved
   * @throws Error if move fails
   */
  static async moveFolder(
    app: App,
    path: string,
    newPath: string,
    overwrite = false
  ): Promise<void> {
    // Normalize paths to remove any leading slashes
    const normalizedPath = normalizePath(path);
    const normalizedNewPath = normalizePath(newPath);
    
    const folder = app.vault.getAbstractFileByPath(normalizedPath);
    if (!folder) {
      throw new Error(`Folder not found: ${path}`);
    }
    
    if (!(folder instanceof TFolder)) {
      throw new Error(`Path is not a folder: ${path}`);
    }
    
    // Check if the destination already exists
    const existingFolder = app.vault.getAbstractFileByPath(normalizedNewPath);
    if (existingFolder) {
      if (overwrite) {
        await app.fileManager.trashFile(existingFolder);
      } else {
        throw new Error(`Destination already exists: ${newPath}`);
      }
    }
    
    // Ensure the parent folder exists
    const parentPath = normalizedNewPath.substring(0, normalizedNewPath.lastIndexOf('/'));
    if (parentPath) {
      await FileOperations.ensureFolder(app, parentPath);
    }
    
    await app.vault.rename(folder, normalizedNewPath);
  }
  
  /**
   * Duplicate a note
   * @param app Obsidian app instance
   * @param sourcePath Path to the source note
   * @param targetPath Path for the duplicate note
   * @param overwrite Whether to overwrite if target exists
   * @param autoIncrement Whether to auto-increment filename if target exists
   * @returns Promise that resolves with duplication details
   * @throws Error if duplication fails
   */
  static async duplicateNote(
    app: App,
    sourcePath: string,
    targetPath: string,
    overwrite = false,
    autoIncrement = false
  ): Promise<{
    sourcePath: string;
    targetPath: string;
    wasAutoIncremented: boolean;
    wasOverwritten: boolean;
  }> {
    // Normalize paths to remove any leading slashes
    const normalizedSourcePath = normalizePath(sourcePath);
    const normalizedTargetPath = normalizePath(targetPath);

    // Check if source file exists
    const sourceFile = app.vault.getAbstractFileByPath(normalizedSourcePath);
    if (!sourceFile) {
      throw new Error(`Source file not found: ${sourcePath}`);
    }

    if (!(sourceFile instanceof TFile)) {
      throw new Error(`Source path is not a file: ${sourcePath}`);
    }

    // Read source content
    const sourceContent = await app.vault.read(sourceFile);
    
    let finalTargetPath = normalizedTargetPath;
    let wasAutoIncremented = false;
    let wasOverwritten = false;

    // Handle existing target file
    let existingTarget = app.vault.getAbstractFileByPath(finalTargetPath);
    
    if (existingTarget) {
      if (autoIncrement) {
        // Auto-increment filename until we find an available one
        let counter = 1;
        const pathParts = finalTargetPath.split('.');
        const extension = pathParts.length > 1 ? `.${pathParts.pop()}` : '';
        const basePath = pathParts.join('.');
        
        do {
          const suffix = counter === 1 ? ' copy' : ` copy ${counter}`;
          finalTargetPath = `${basePath}${suffix}${extension}`;
          existingTarget = app.vault.getAbstractFileByPath(finalTargetPath);
          counter++;
        } while (existingTarget && counter < 1000); // Safety limit
        
        if (counter >= 1000) {
          throw new Error('Too many duplicates - unable to find available filename');
        }
        
        wasAutoIncremented = counter > 1;
      } else if (overwrite) {
        // Delete existing file
        await app.fileManager.trashFile(existingTarget);
        wasOverwritten = true;
      } else {
        throw new Error(`Target file already exists: ${targetPath}`);
      }
    }

    // Ensure target directory exists
    const targetFolderPath = finalTargetPath.substring(0, finalTargetPath.lastIndexOf('/'));
    if (targetFolderPath) {
      await FileOperations.ensureFolder(app, targetFolderPath);
    }

    // Create the duplicate
    await app.vault.create(finalTargetPath, sourceContent);

    return {
      sourcePath: normalizedSourcePath,
      targetPath: finalTargetPath,
      wasAutoIncremented,
      wasOverwritten
    };
  }
}
