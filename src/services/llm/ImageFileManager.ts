/**
 * Image File Manager
 * Handles saving generated images to the Obsidian vault with proper security and metadata
 */

import { Vault, TFile, TFolder } from 'obsidian';
import {
  ImageGenerationParams,
  ImageGenerationResponse,
  ImageSaveResult,
  ImageBuffer
} from './types/ImageTypes';

/**
 * Pure JS path utilities to avoid Node.js 'path' module on mobile
 */
const pathUtils = {
  basename(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash === -1 ? normalized : normalized.substring(lastSlash + 1);
  },
  dirname(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash === -1 ? '.' : normalized.substring(0, lastSlash);
  },
  extname(filePath: string): string {
    const base = pathUtils.basename(filePath);
    const lastDot = base.lastIndexOf('.');
    return lastDot <= 0 ? '' : base.substring(lastDot);
  },
  normalize(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/\/+/g, '/');
  }
};

export class ImageFileManager {
  private vault: Vault;

  constructor(vault: Vault) {
    this.vault = vault;
  }

  /**
   * Save generated image to vault with metadata
   */
  async saveImage(
    imageResponse: ImageGenerationResponse,
    params: ImageGenerationParams
  ): Promise<ImageSaveResult> {
    try {
      // Validate and sanitize the save path
      const sanitizedPath = this.sanitizePath(params.savePath);
      const finalPath = await this.ensureUniqueFileName(sanitizedPath, imageResponse.format);

      // Ensure directory exists
      await this.ensureDirectoryExists(pathUtils.dirname(finalPath));

      // Save the image file
      const arrayBuffer = new ArrayBuffer(imageResponse.imageData.length);
      const uint8Array = new Uint8Array(arrayBuffer);
      uint8Array.set(imageResponse.imageData);
      const file = await this.vault.createBinary(finalPath, arrayBuffer);

      return {
        success: true,
        filePath: finalPath,
        fileName: pathUtils.basename(finalPath),
        fileSize: imageResponse.imageData.length,
        dimensions: imageResponse.dimensions,
        format: imageResponse.format
      };
    } catch (error) {
      return {
        success: false,
        filePath: params.savePath,
        fileName: pathUtils.basename(params.savePath),
        fileSize: 0,
        dimensions: { width: 0, height: 0 },
        format: imageResponse.format,
        error: error instanceof Error ? error.message : 'Unknown error saving image'
      };
    }
  }

  /**
   * Save multiple images from a batch generation
   */
  async saveImages(
    imageResponses: ImageGenerationResponse[],
    params: ImageGenerationParams
  ): Promise<ImageSaveResult[]> {
    const results: ImageSaveResult[] = [];

    for (let i = 0; i < imageResponses.length; i++) {
      const imageResponse = imageResponses[i];

      // Create unique save path for each image
      const basePath = this.removeExtension(params.savePath);
      const extension = this.getFileExtension(imageResponse.format);
      const indexedPath = imageResponses.length > 1
        ? `${basePath}-${i + 1}.${extension}`
        : `${basePath}.${extension}`;

      const indexedParams = { ...params, savePath: indexedPath };
      const result = await this.saveImage(imageResponse, indexedParams);
      results.push(result);
    }

    return results;
  }

  /**
   * Check if a file path is safe (within vault, no directory traversal)
   */
  private validatePath(filePath: string): boolean {
    // Normalize the path
    const normalizedPath = pathUtils.normalize(filePath);

    // Check for directory traversal attempts
    if (normalizedPath.includes('..') || normalizedPath.startsWith('/')) {
      return false;
    }

    // Check for invalid characters
    const invalidChars = /[<>:"|?*]/;
    if (invalidChars.test(normalizedPath)) {
      return false;
    }

    return true;
  }

  /**
   * Sanitize file path for vault storage
   */
  private sanitizePath(filePath: string): string {
    if (!this.validatePath(filePath)) {
      throw new Error('Invalid file path: contains directory traversal or invalid characters');
    }

    // Remove leading/trailing whitespace and normalize separators
    let sanitized = filePath.trim().replace(/\\/g, '/');

    // Remove leading slash if present
    if (sanitized.startsWith('/')) {
      sanitized = sanitized.substring(1);
    }

    // Ensure the path has a valid image extension
    const validExtensions = ['png', 'jpg', 'jpeg', 'webp'];
    const ext = pathUtils.extname(sanitized).toLowerCase().substring(1);

    if (!ext || !validExtensions.includes(ext)) {
      sanitized = this.removeExtension(sanitized) + '.png';
    }

    return sanitized;
  }

  /**
   * Ensure directory exists, create if necessary
   */
  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    if (!dirPath || dirPath === '.') {
      return; // Root directory
    }

    const folderPath = pathUtils.normalize(dirPath);

    // Check if folder already exists
    const existingFolder = this.vault.getAbstractFileByPath(folderPath);
    if (existingFolder instanceof TFolder) {
      return; // Folder already exists
    }

    // Create the folder (this will create parent directories as needed)
    try {
      await this.vault.createFolder(folderPath);
    } catch (error) {
      // Folder might already exist due to race condition
      const folder = this.vault.getAbstractFileByPath(folderPath);
      if (!(folder instanceof TFolder)) {
        throw error;
      }
    }
  }

  /**
   * Ensure filename is unique, append number if needed
   */
  private async ensureUniqueFileName(filePath: string, format: string): Promise<string> {
    let finalPath = filePath;
    let counter = 1;

    // Ensure the file has the correct extension
    const basePath = this.removeExtension(filePath);
    const extension = this.getFileExtension(format);
    finalPath = `${basePath}.${extension}`;

    while (this.vault.getAbstractFileByPath(finalPath)) {
      finalPath = `${basePath}-${counter}.${extension}`;
      counter++;
    }

    return finalPath;
  }


  /**
   * Get file extension for format
   */
  private getFileExtension(format: string): string {
    const extensions = {
      'png': 'png',
      'jpeg': 'jpg',
      'jpg': 'jpg',
      'webp': 'webp'
    };
    return extensions[format.toLowerCase() as keyof typeof extensions] || 'png';
  }

  /**
   * Remove file extension from path
   */
  private removeExtension(filePath: string): string {
    const ext = pathUtils.extname(filePath);
    return ext ? filePath.substring(0, filePath.length - ext.length) : filePath;
  }

  /**
   * Check if file exists in vault
   */
  async fileExists(filePath: string): Promise<boolean> {
    const file = this.vault.getAbstractFileByPath(filePath);
    return file instanceof TFile;
  }

  /**
   * Get available disk space (estimate)
   */
  getAvailableSpace(): number {
    // This is a rough estimate as there's no direct API for disk space in Obsidian
    // Return a conservative estimate
    return 100 * 1024 * 1024; // 100MB
  }

  /**
   * Validate image buffer and extract metadata
   */
  validateImageBuffer(buffer: Buffer): ImageBuffer | null {
    if (!buffer || buffer.length === 0) {
      return null;
    }

    try {
      // Basic PNG validation (check PNG signature)
      const isPNG = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));

      // Basic JPEG validation (check JPEG signature)
      const isJPEG = buffer.subarray(0, 2).equals(Buffer.from([0xFF, 0xD8]));

      // Basic WebP validation (check WebP signature)
      const isWebP = buffer.subarray(0, 4).equals(Buffer.from('RIFF', 'ascii')) &&
                     buffer.subarray(8, 12).equals(Buffer.from('WEBP', 'ascii'));

      let format: 'png' | 'jpeg' | 'webp';
      if (isPNG) format = 'png';
      else if (isJPEG) format = 'jpeg';
      else if (isWebP) format = 'webp';
      else return null; // Unsupported format

      return {
        data: buffer,
        format,
        dimensions: { width: 0, height: 0 }, // Would need image parsing library for actual dimensions
        metadata: {
          prompt: '',
          model: '',
          provider: '',
          generatedAt: new Date().toISOString(),
          fileSize: buffer.length
        }
      };
    } catch (error) {
      return null;
    }
  }
}
