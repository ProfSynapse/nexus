/**
 * WebLLMModelManager
 *
 * Single Responsibility: Handle model download, storage, and deletion.
 * Manages model files in the vault's .obsidian/models/ directory.
 */

import { Vault, requestUrl, FileSystemAdapter } from 'obsidian';
import {
  InstalledModel,
  DownloadProgress,
  ModelManifest,
  ModelFile,
  WebLLMError,
  WebLLMModelSpec,
} from './types';
import { HF_BASE_URL, getWebLLMModel } from './WebLLMModels';

/** Default model storage path within vault */
const MODEL_STORAGE_PATH = '.obsidian/models';

/** Manifest file name for tracking installed models */
const INSTALLED_MANIFEST = 'installed-models.json';

export class WebLLMModelManager {
  private vault: Vault;
  private storagePath: string;

  constructor(vault: Vault, customStoragePath?: string) {
    this.vault = vault;
    this.storagePath = customStoragePath || MODEL_STORAGE_PATH;
  }

  // ============================================================================
  // Model Installation Status
  // ============================================================================

  /**
   * Check if a model is installed
   */
  async isModelInstalled(modelId: string): Promise<boolean> {
    const installed = await this.getInstalledModels();
    return installed.some(m => m.id === modelId);
  }

  /**
   * Get list of installed models
   */
  async getInstalledModels(): Promise<InstalledModel[]> {
    try {
      const manifestPath = `${this.storagePath}/${INSTALLED_MANIFEST}`;
      const exists = await this.vault.adapter.exists(manifestPath);

      if (!exists) {
        return [];
      }

      const content = await this.vault.adapter.read(manifestPath);
      return JSON.parse(content);
    } catch (error) {
      return [];
    }
  }

  /**
   * Get the storage path for a specific model
   */
  getModelPath(modelId: string): string {
    return `${this.storagePath}/${modelId}`;
  }

  // ============================================================================
  // Model Download
  // ============================================================================

  /**
   * Download a model from HuggingFace Hub
   */
  async downloadModel(
    modelSpec: WebLLMModelSpec,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<void> {
    const modelPath = this.getModelPath(modelSpec.id);

    // Ensure storage directories exist
    await this.ensureDirectoryExists(this.storagePath);
    await this.ensureDirectoryExists(modelPath);

    try {
      // Fetch model manifest from HuggingFace
      const manifest = await this.fetchModelManifest(modelSpec);

      // Download each file
      let downloadedBytes = 0;
      const totalBytes = manifest.totalSize;

      for (let i = 0; i < manifest.files.length; i++) {
        const file = manifest.files[i];

        // Report progress
        if (onProgress) {
          onProgress({
            totalBytes,
            downloadedBytes,
            percentage: totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0,
            currentFile: file.name,
            filesComplete: i,
            filesTotal: manifest.files.length,
          });
        }

        // Download file
        const filePath = `${modelPath}/${file.name}`;
        await this.downloadFile(file.url, filePath, (bytes) => {
          if (onProgress) {
            onProgress({
              totalBytes,
              downloadedBytes: downloadedBytes + bytes,
              percentage: totalBytes > 0 ? ((downloadedBytes + bytes) / totalBytes) * 100 : 0,
              currentFile: file.name,
              filesComplete: i,
              filesTotal: manifest.files.length,
            });
          }
        });

        downloadedBytes += file.size;
      }

      // Save model config
      await this.saveModelConfig(modelPath, manifest);

      // Update installed models manifest
      await this.addInstalledModel({
        id: modelSpec.id,
        name: modelSpec.name,
        quantization: modelSpec.quantization,
        sizeBytes: totalBytes,
        installedAt: new Date().toISOString(),
        path: modelPath,
      });
    } catch (error) {
      // Clean up partial download on failure
      await this.deleteModelFiles(modelPath);

      throw new WebLLMError(
        `Failed to download model: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'DOWNLOAD_FAILED',
        error
      );
    }
  }

  /**
   * Get the base URL path for model files
   * Handles both flat structure (files at root) and nested structure (files in quantization subdirectory)
   */
  private getModelBasePath(modelSpec: WebLLMModelSpec): string {
    if (modelSpec.flatStructure) {
      return `${HF_BASE_URL}/${modelSpec.huggingFaceRepo}/resolve/main`;
    }
    return `${HF_BASE_URL}/${modelSpec.huggingFaceRepo}/resolve/main/${modelSpec.quantization}`;
  }

  /**
   * Fetch model manifest from HuggingFace
   * The manifest contains the list of files to download
   */
  private async fetchModelManifest(modelSpec: WebLLMModelSpec): Promise<ModelManifest> {
    const basePath = this.getModelBasePath(modelSpec);
    const configUrl = `${basePath}/mlc-chat-config.json`;

    try {
      const response = await requestUrl({
        url: configUrl,
        method: 'GET',
      });

      if (response.status !== 200) {
        throw new Error(`Failed to fetch manifest: ${response.status}`);
      }

      const config = response.json;

      // Parse file list from config
      // MLC models typically have: mlc-chat-config.json, tokenizer files, and weight shards
      const files: ModelFile[] = [];
      let totalSize = 0;

      // Add config file
      files.push({
        name: 'mlc-chat-config.json',
        url: configUrl,
        size: JSON.stringify(config).length,
      });

      // Add tokenizer files
      const tokenizerFiles = ['tokenizer.json', 'tokenizer_config.json', 'tokenizer.model'];
      for (const tokenFile of tokenizerFiles) {
        const url = `${basePath}/${tokenFile}`;
        try {
          // Check if file exists (HEAD request)
          const headResp = await requestUrl({ url, method: 'HEAD' });
          if (headResp.status === 200) {
            const size = parseInt(headResp.headers['content-length'] || '0', 10);
            files.push({ name: tokenFile, url, size });
            totalSize += size;
          }
        } catch {
          // File doesn't exist, skip
        }
      }

      // Check for tensor-cache.json (MLC LLM standard format)
      // This file lists all weight shards with their sizes
      const tensorCacheUrl = `${basePath}/tensor-cache.json`;
      try {
        const tensorResp = await requestUrl({ url: tensorCacheUrl, method: 'GET' });
        if (tensorResp.status === 200) {
          const tensorConfig = tensorResp.json;
          files.push({
            name: 'tensor-cache.json',
            url: tensorCacheUrl,
            size: JSON.stringify(tensorConfig).length,
          });

          // Add all weight shards listed in tensor-cache.json
          if (tensorConfig.records && Array.isArray(tensorConfig.records)) {
            for (const record of tensorConfig.records) {
              if (record.dataPath) {
                const dataUrl = `${basePath}/${record.dataPath}`;
                // Use size from metadata if available
                const size = record.nbytes || 0;
                files.push({ name: record.dataPath, url: dataUrl, size });
                totalSize += size;
              }
            }
          }
        }
      } catch {
        // No tensor cache, fall back to probing for shards
        // Probe for weight shards until we get a 404
        for (let i = 0; i < 200; i++) { // Max 200 shards
          const shardName = `params_shard_${i}.bin`;
          const url = `${basePath}/${shardName}`;

          try {
            const headResp = await requestUrl({ url, method: 'HEAD' });
            if (headResp.status === 200) {
              const size = parseInt(headResp.headers['content-length'] || '0', 10);
              files.push({ name: shardName, url, size });
              totalSize += size;
            } else {
              break;
            }
          } catch {
            // Shard doesn't exist, stop looking
            break;
          }
        }
      }

      return {
        modelId: modelSpec.id,
        quantization: modelSpec.quantization,
        files,
        configUrl,
        totalSize,
      };
    } catch (error) {
      throw new WebLLMError(
        `Failed to fetch model manifest: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'DOWNLOAD_FAILED',
        error
      );
    }
  }

  /**
   * Download a single file
   */
  private async downloadFile(
    url: string,
    localPath: string,
    onProgress?: (downloadedBytes: number) => void
  ): Promise<void> {
    try {
      // Check if file already exists (for resume support)
      const exists = await this.vault.adapter.exists(localPath);
      if (exists) {
        return;
      }

      // Download using Obsidian's requestUrl (handles CORS)
      const response = await requestUrl({
        url,
        method: 'GET',
      });

      if (response.status !== 200) {
        throw new Error(`Download failed: ${response.status}`);
      }

      // Write to vault
      await this.vault.adapter.writeBinary(localPath, response.arrayBuffer);

      if (onProgress) {
        onProgress(response.arrayBuffer.byteLength);
      }
    } catch (error) {
      throw new WebLLMError(
        `Failed to download file ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'DOWNLOAD_FAILED',
        error
      );
    }
  }

  /**
   * Save model configuration
   */
  private async saveModelConfig(modelPath: string, manifest: ModelManifest): Promise<void> {
    const configPath = `${modelPath}/manifest.json`;
    await this.vault.adapter.write(configPath, JSON.stringify(manifest, null, 2));
  }

  // ============================================================================
  // Model Deletion
  // ============================================================================

  /**
   * Delete a model from storage
   */
  async deleteModel(modelId: string): Promise<void> {
    const modelPath = this.getModelPath(modelId);

    // Delete model files
    await this.deleteModelFiles(modelPath);

    // Update installed models manifest
    await this.removeInstalledModel(modelId);
  }

  /**
   * Delete model files recursively
   */
  private async deleteModelFiles(path: string): Promise<void> {
    try {
      const exists = await this.vault.adapter.exists(path);
      if (!exists) return;

      const stat = await this.vault.adapter.stat(path);

      if (stat?.type === 'folder') {
        const files = await this.vault.adapter.list(path);

        // Delete all files
        for (const file of files.files) {
          await this.vault.adapter.remove(file);
        }

        // Delete subfolders recursively
        for (const folder of files.folders) {
          await this.deleteModelFiles(folder);
        }

        // Delete the folder itself
        await this.vault.adapter.rmdir(path, true);
      } else {
        await this.vault.adapter.remove(path);
      }
    } catch (error) {
      // Ignore deletion errors
    }
  }

  // ============================================================================
  // Installed Models Manifest
  // ============================================================================

  /**
   * Add a model to the installed manifest
   */
  private async addInstalledModel(model: InstalledModel): Promise<void> {
    const installed = await this.getInstalledModels();

    // Remove existing entry if present
    const filtered = installed.filter(m => m.id !== model.id);
    filtered.push(model);

    await this.saveInstalledManifest(filtered);
  }

  /**
   * Remove a model from the installed manifest
   */
  private async removeInstalledModel(modelId: string): Promise<void> {
    const installed = await this.getInstalledModels();
    const filtered = installed.filter(m => m.id !== modelId);
    await this.saveInstalledManifest(filtered);
  }

  /**
   * Save the installed models manifest
   */
  private async saveInstalledManifest(models: InstalledModel[]): Promise<void> {
    await this.ensureDirectoryExists(this.storagePath);
    const manifestPath = `${this.storagePath}/${INSTALLED_MANIFEST}`;
    await this.vault.adapter.write(manifestPath, JSON.stringify(models, null, 2));
  }

  // ============================================================================
  // File Reading (for serving to worker)
  // ============================================================================

  /**
   * Read a model file as ArrayBuffer
   * Used to serve model weights to the worker
   */
  async readModelFile(modelId: string, fileName: string): Promise<ArrayBuffer> {
    const filePath = `${this.getModelPath(modelId)}/${fileName}`;

    const exists = await this.vault.adapter.exists(filePath);
    if (!exists) {
      throw new WebLLMError(
        `Model file not found: ${fileName}`,
        'MODEL_NOT_FOUND'
      );
    }

    return await this.vault.adapter.readBinary(filePath);
  }

  /**
   * Get model file URL for local serving
   * Returns a file:// URL or blob URL for local access
   */
  async getLocalModelUrl(modelId: string): Promise<string> {
    const modelPath = this.getModelPath(modelId);

    const adapter: any = this.vault.adapter;
    if (typeof adapter.getResourcePath === 'function') {
      return adapter.getResourcePath(modelPath);
    }

    if (adapter instanceof FileSystemAdapter) {
      return `file://${adapter.getBasePath()}/${modelPath}`;
    }

    // Fallback: relative path
    return modelPath;
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Ensure a directory exists, creating it if necessary
   */
  private async ensureDirectoryExists(path: string): Promise<void> {
    try {
      const exists = await this.vault.adapter.exists(path);
      if (!exists) {
        await this.vault.adapter.mkdir(path);
      }
    } catch (error) {
      // Directory might already exist, ignore error
    }
  }

  /**
   * Get total size of installed models
   */
  async getTotalInstalledSize(): Promise<number> {
    const installed = await this.getInstalledModels();
    return installed.reduce((total, model) => total + model.sizeBytes, 0);
  }

  /**
   * Format bytes for display
   */
  static formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${units[i]}`;
  }
}
