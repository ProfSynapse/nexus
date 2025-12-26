import { App, TFile } from 'obsidian';
import { diff_match_patch } from 'diff-match-patch';

/**
 * Utility class for content operations
 */
export class ContentOperations {
  /**
   * Normalize file path by removing any leading slash
   * @param filePath Path to normalize
   * @returns Normalized path
   */
  private static normalizePath(filePath: string): string {
    // Remove leading slash if present
    return filePath.startsWith('/') ? filePath.slice(1) : filePath;
  }

  /**
   * Read the content of a note
   * @param app Obsidian app instance
   * @param filePath Path to the note
   * @returns Promise that resolves with the note content
   */
  static async readContent(app: App, filePath: string): Promise<string> {
    try {
      // Normalize path to remove any leading slash
      const normalizedPath = this.normalizePath(filePath);
      const file = app.vault.getAbstractFileByPath(normalizedPath);
      
      if (!file) {
        throw new Error(`File not found: "${filePath}". Use searchContent to find files by name, or listDirectory to explore folders.`);
      }
      
      if (!(file instanceof TFile)) {
        throw new Error(`Path is a folder, not a file: "${filePath}". Use listDirectory to see its contents.`);
      }
      
      return await app.vault.read(file);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Error reading file: ${errorMessage}`);
    }
  }
  
  /**
   * Read the content of a note with line numbers
   * @param app Obsidian app instance
   * @param filePath Path to the note
   * @returns Promise that resolves with the note content including line numbers
   */
  static async readContentWithLineNumbers(app: App, filePath: string): Promise<string> {
    try {
      // Normalize path is handled by readContent internally
      const content = await this.readContent(app, filePath);
      const lines = content.split('\n');
      
      return lines.map((line, index) => `${index + 1}: ${line}`).join('\n');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Error reading file with line numbers: ${errorMessage}`);
    }
  }
  
  /**
   * Read specific lines from a note
   * @param app Obsidian app instance
   * @param filePath Path to the note
   * @param startLine Start line (1-based)
   * @param endLine End line (1-based, inclusive)
   * @param includeLineNumbers Whether to include line numbers in output
   * @returns Promise that resolves with the specified lines
   */
  static async readLines(
    app: App, 
    filePath: string, 
    startLine: number, 
    endLine: number,
    includeLineNumbers = false
  ): Promise<string[]> {
    try {
      // Normalize path is handled by readContent internally
      const content = await this.readContent(app, filePath);
      const lines = content.split('\n');
      
      // Adjust for 1-based line numbers
      startLine = Math.max(1, startLine);
      endLine = Math.min(lines.length, endLine);
      
      if (startLine > endLine) {
        throw new Error('Start line cannot be greater than end line');
      }
      
      const selectedLines = lines.slice(startLine - 1, endLine);
      
      if (includeLineNumbers) {
        return selectedLines.map((line, index) => `${startLine + index}: ${line}`);
      }
      
      return selectedLines;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Error reading lines: ${errorMessage}`);
    }
  }
  
  /**
   * Create a new file with content
   * @param app Obsidian app instance
   * @param filePath Path to the new file
   * @param content Content for the new file
   * @returns Promise that resolves with the created file
   */
  static async createContent(app: App, filePath: string, content: string): Promise<TFile> {
    try {
      // Normalize path to remove any leading slash
      const normalizedPath = this.normalizePath(filePath);
      const file = app.vault.getAbstractFileByPath(normalizedPath);
      
      if (file) {
        throw new Error(`File already exists: "${filePath}". Use readContent to view it, or appendContent/prependContent to add to it.`);
      }
      
      // Ensure parent folders exist
      const folderPath = normalizedPath.substring(0, normalizedPath.lastIndexOf('/'));
      if (folderPath) {
        // Normalize the folder path as well
        await app.vault.createFolder(folderPath).catch(() => {
          // Folder might already exist, ignore error
        });
      }
      
      return await app.vault.create(normalizedPath, content);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Error creating file: ${errorMessage}`);
    }
  }
  
  /**
   * Append content to a file
   * @param app Obsidian app instance
   * @param filePath Path to the file
   * @param content Content to append
   * @returns Promise that resolves when the content is appended
   */
  static async appendContent(app: App, filePath: string, content: string): Promise<{
    appendedLength: number;
    totalLength: number;
  }> {
    try {
      // Normalize path to remove any leading slash
      const normalizedPath = this.normalizePath(filePath);
      const file = app.vault.getAbstractFileByPath(normalizedPath);
      
      if (!file) {
        throw new Error(`File not found: "${filePath}". Use searchContent to find files by name, or listDirectory to explore folders.`);
      }
      
      if (!(file instanceof TFile)) {
        throw new Error(`Path is a folder, not a file: "${filePath}". Use listDirectory to see its contents.`);
      }
      
      const existingContent = await app.vault.read(file);
      const newContent = existingContent + content;
      
      await app.vault.modify(file, newContent);
      
      return {
        appendedLength: content.length,
        totalLength: newContent.length
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Error appending to file: ${errorMessage}`);
    }
  }
  
  /**
   * Prepend content to a file
   * @param app Obsidian app instance
   * @param filePath Path to the file
   * @param content Content to prepend
   * @returns Promise that resolves when the content is prepended
   */
  static async prependContent(app: App, filePath: string, content: string): Promise<{
    prependedLength: number;
    totalLength: number;
  }> {
    try {
      // Normalize path to remove any leading slash
      const normalizedPath = this.normalizePath(filePath);
      const file = app.vault.getAbstractFileByPath(normalizedPath);
      
      if (!file) {
        throw new Error(`File not found: "${filePath}". Use searchContent to find files by name, or listDirectory to explore folders.`);
      }
      
      if (!(file instanceof TFile)) {
        throw new Error(`Path is a folder, not a file: "${filePath}". Use listDirectory to see its contents.`);
      }
      
      const existingContent = await app.vault.read(file);
      const newContent = content + existingContent;
      
      await app.vault.modify(file, newContent);
      
      return {
        prependedLength: content.length,
        totalLength: newContent.length
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Error prepending to file: ${errorMessage}`);
    }
  }
  
  /**
   * Replace content in a file using fuzzy matching
   * @param app Obsidian app instance
   * @param filePath Path to the file
   * @param oldContent Content to replace
   * @param newContent Content to replace with
   * @param similarityThreshold Threshold for fuzzy matching (0.0 to 1.0, where 1.0 is exact match)
   * @returns Promise that resolves with the number of replacements made
   */
  static async replaceContent(
    app: App,
    filePath: string,
    oldContent: string,
    newContent: string,
    similarityThreshold = 0.95
  ): Promise<number> {
    try {
      // Normalize path to remove any leading slash
      const normalizedPath = this.normalizePath(filePath);
      const file = app.vault.getAbstractFileByPath(normalizedPath);
      
      if (!file) {
        throw new Error(`File not found: "${filePath}". Use searchContent to find files by name, or listDirectory to explore folders.`);
      }
      
      if (!(file instanceof TFile)) {
        throw new Error(`Path is a folder, not a file: "${filePath}". Use listDirectory to see its contents.`);
      }
      
      const existingContent = await app.vault.read(file);
      
      // Try exact match first
      const regex = new RegExp(this.escapeRegExp(oldContent), 'g');
      const exactMatches = (existingContent.match(regex) || []).length;
      
      if (exactMatches > 0) {
        // Perform exact replacement if found
        const modifiedContent = existingContent.replace(regex, newContent);
        await app.vault.modify(file, modifiedContent);
        return exactMatches;
      }
      
      // If no exact match, try fuzzy matching
      const dmp = new diff_match_patch();
      
      // Configure the matcher
      dmp.Match_Threshold = similarityThreshold;
      dmp.Match_Distance = 1000; // Maximum distance to search
      
      // Find the best match position
      const matchPosition = dmp.match_main(existingContent, oldContent, 0);
      
      if (matchPosition === -1) {
        // No match found even with fuzzy matching - provide recovery guidance
        throw new Error(`Content to replace not found in "${filePath}" (tried fuzzy matching at ${similarityThreshold * 100}% threshold). Use readContent to view the exact file contents first, then copy the EXACT text you want to replace.`);
      }
      
      // Extract the actual matched text for informational purposes
      const matchedLength = oldContent.length;
      const actualMatchedText = existingContent.substring(matchPosition, matchPosition + matchedLength);
      
      
      // Create a clean replacement by slicing the original content
      const beforeMatch = existingContent.substring(0, matchPosition);
      const afterMatch = existingContent.substring(matchPosition + matchedLength);
      const modifiedContent = beforeMatch + newContent + afterMatch;
      
      // Modify the file
      await app.vault.modify(file, modifiedContent);
      
      return 1; // One fuzzy replacement made
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Error replacing content: ${errorMessage}`);
    }
  }
  
  /**
   * Replace specific lines in a file
   * @param app Obsidian app instance
   * @param filePath Path to the file
   * @param startLine Start line (1-based)
   * @param endLine End line (1-based, inclusive)
   * @param newContent Content to replace with
   * @returns Promise that resolves with the number of lines replaced
   */
  static async replaceByLine(
    app: App,
    filePath: string,
    startLine: number,
    endLine: number,
    newContent: string
  ): Promise<number> {
    try {
      // Normalize path to remove any leading slash
      const normalizedPath = this.normalizePath(filePath);
      const file = app.vault.getAbstractFileByPath(normalizedPath);
      
      if (!file) {
        throw new Error(`File not found: "${filePath}". Use searchContent to find files by name, or listDirectory to explore folders.`);
      }
      
      if (!(file instanceof TFile)) {
        throw new Error(`Path is a folder, not a file: "${filePath}". Use listDirectory to see its contents.`);
      }
      
      const existingContent = await app.vault.read(file);
      const lines = existingContent.split('\n');
      
      // Adjust for 1-based line numbers
      startLine = Math.max(1, startLine);
      endLine = Math.min(lines.length, endLine);
      
      if (startLine > endLine) {
        throw new Error('Start line cannot be greater than end line');
      }
      
      const linesReplaced = endLine - startLine + 1;
      
      // Replace lines
      const beforeLines = lines.slice(0, startLine - 1);
      const afterLines = lines.slice(endLine);
      
      const newLines = newContent.split('\n');
      
      const modifiedContent = [
        ...beforeLines,
        ...newLines,
        ...afterLines
      ].join('\n');
      
      await app.vault.modify(file, modifiedContent);
      
      return linesReplaced;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Error replacing lines: ${errorMessage}`);
    }
  }
  
  /**
   * Delete content from a file with fuzzy matching support
   * @param app Obsidian app instance
   * @param filePath Path to the file
   * @param content Content to delete
   * @param similarityThreshold Threshold for fuzzy matching (0.0 to 1.0, where 1.0 is exact match)
   * @returns Promise that resolves with the number of deletions made
   */
  static async deleteContent(
    app: App,
    filePath: string,
    content: string,
    similarityThreshold = 0.95
  ): Promise<number> {
    try {
      // Normalize path to remove any leading slash
      const normalizedPath = this.normalizePath(filePath);
      const file = app.vault.getAbstractFileByPath(normalizedPath);
      
      if (!file) {
        throw new Error(`File not found: "${filePath}". Use searchContent to find files by name, or listDirectory to explore folders.`);
      }
      
      if (!(file instanceof TFile)) {
        throw new Error(`Path is a folder, not a file: "${filePath}". Use listDirectory to see its contents.`);
      }
      
      const existingContent = await app.vault.read(file);
      
      // Try exact match first
      const regex = new RegExp(this.escapeRegExp(content), 'g');
      const exactMatches = (existingContent.match(regex) || []).length;
      
      if (exactMatches > 0) {
        // Perform exact deletion if found
        const modifiedContent = existingContent.replace(regex, '');
        await app.vault.modify(file, modifiedContent);
        return exactMatches;
      }
      
      // If no exact match, try fuzzy matching
      const dmp = new diff_match_patch();
      
      // Configure the matcher
      dmp.Match_Threshold = similarityThreshold;
      dmp.Match_Distance = 1000; // Maximum distance to search
      
      // Find the best match position
      const matchPosition = dmp.match_main(existingContent, content, 0);
      
      if (matchPosition === -1) {
        // No match found even with fuzzy matching
        throw new Error(`Content to delete not found in file, even with fuzzy matching at ${similarityThreshold * 100}% threshold`);
      }
      
      // Extract the actual matched text for informational purposes
      const matchedLength = content.length;
      const actualMatchedText = existingContent.substring(matchPosition, matchPosition + matchedLength);
      
      
      // Create a clean deletion by slicing the original content
      const beforeMatch = existingContent.substring(0, matchPosition);
      const afterMatch = existingContent.substring(matchPosition + matchedLength);
      const modifiedContent = beforeMatch + afterMatch;
      
      // Modify the file
      await app.vault.modify(file, modifiedContent);
      
      return 1; // One fuzzy deletion made
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Error deleting content: ${errorMessage}`);
    }
  }
  
  /**
   * Find and replace text in a file
   * @param app Obsidian app instance
   * @param filePath Path to the file
   * @param findText Text to find
   * @param replaceText Text to replace with
   * @param replaceAll Whether to replace all occurrences or just the first one
   * @param caseSensitive Whether the search should be case sensitive
   * @param wholeWord Whether to use whole word matching
   * @returns Promise that resolves with the number of replacements made
   */
  static async findReplaceContent(
    app: App,
    filePath: string,
    findText: string,
    replaceText: string,
    replaceAll = false,
    caseSensitive = true,
    wholeWord = false
  ): Promise<number> {
    try {
      // Normalize path to remove any leading slash
      const normalizedPath = this.normalizePath(filePath);
      const file = app.vault.getAbstractFileByPath(normalizedPath);
      
      if (!file) {
        throw new Error(`File not found: "${filePath}". Use searchContent to find files by name, or listDirectory to explore folders.`);
      }
      
      if (!(file instanceof TFile)) {
        throw new Error(`Path is a folder, not a file: "${filePath}". Use listDirectory to see its contents.`);
      }
      
      const existingContent = await app.vault.read(file);
      
      // Build regex pattern
      let pattern = this.escapeRegExp(findText);
      
      // Add word boundaries if wholeWord is true
      if (wholeWord) {
        pattern = `\\b${pattern}\\b`;
      }
      
      // Create regex with appropriate flags
      const flags = (caseSensitive ? '' : 'i') + (replaceAll ? 'g' : '');
      const regex = new RegExp(pattern, flags);
      
      // Count matches before replacement
      const matches = existingContent.match(regex);
      const matchCount = matches ? matches.length : 0;
      
      if (matchCount === 0) {
        // No matches found
        return 0;
      }
      
      // Perform replacement
      const modifiedContent = existingContent.replace(regex, replaceText);
      await app.vault.modify(file, modifiedContent);
      
      return matchCount;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Error in find and replace: ${errorMessage}`);
    }
  }

  /**
   * Escape special characters in a string for use in a regular expression
   * @param string String to escape
   * @returns Escaped string
   */
  private static escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}