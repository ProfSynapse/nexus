/**
 * WebLLMCachePrefetcher
 *
 * Pre-fetches model files and stores them in the browser Cache API.
 *
 * Why this is needed:
 * - HuggingFace stores large files in XetHub (Git LFS replacement)
 * - XetHub URLs redirect to cas-bridge.xethub.hf.co
 * - WebLLM uses Cache.add(url) which fails on redirects
 * - Solution: Pre-fetch files with requestUrl (follows redirects, handles CORS)
 *   and store with cache.put(originalUrl, response)
 *
 * When WebLLM later tries to fetch the same URLs, they'll be in cache.
 */

import { requestUrl } from 'obsidian';
import { WebLLMModelSpec } from './types';
import { HF_BASE_URL } from './WebLLMModels';

export interface PrefetchProgress {
  totalFiles: number;
  completedFiles: number;
  currentFile: string;
  totalBytes: number;
  downloadedBytes: number;
  percentage: number;
}

const CACHE_NAME = 'webllm-prefetch-cache';

/**
 * Get list of files to prefetch for a model
 */
async function getModelFileList(modelSpec: WebLLMModelSpec): Promise<Array<{ name: string; url: string; size: number }>> {
  const basePath = modelSpec.flatStructure
    ? `${HF_BASE_URL}/${modelSpec.huggingFaceRepo}/resolve/main`
    : `${HF_BASE_URL}/${modelSpec.huggingFaceRepo}/resolve/main/${modelSpec.quantization}`;

  const files: Array<{ name: string; url: string; size: number }> = [];

  // Always include config
  files.push({
    name: 'mlc-chat-config.json',
    url: `${basePath}/mlc-chat-config.json`,
    size: 0
  });

  // Fetch tensor-cache.json to get shard list
  try {
    const tensorCacheUrl = `${basePath}/tensor-cache.json`;
    const resp = await requestUrl({ url: tensorCacheUrl, method: 'GET' });
    if (resp.status === 200) {
      const tensorConfig = resp.json;
      files.push({ name: 'tensor-cache.json', url: tensorCacheUrl, size: 0 });

      // Add all shards from tensor-cache
      if (tensorConfig.records && Array.isArray(tensorConfig.records)) {
        for (const record of tensorConfig.records) {
          if (record.dataPath) {
            files.push({
              name: record.dataPath,
              url: `${basePath}/${record.dataPath}`,
              size: record.nbytes || 0,
            });
          }
        }
      }
    }
  } catch {
    // Fall back to probing for shards
    for (let i = 0; i < 200; i++) {
      const shardName = `params_shard_${i}.bin`;
      const url = `${basePath}/${shardName}`;
      try {
        const resp = await requestUrl({ url, method: 'HEAD' });
        if (resp.status === 200) {
          const size = parseInt(resp.headers['content-length'] || '0', 10);
          files.push({ name: shardName, url, size });
        } else {
          break;
        }
      } catch {
        break;
      }
    }
  }

  // Add tokenizer files
  const tokenizerFiles = ['tokenizer.json', 'tokenizer_config.json', 'vocab.json', 'merges.txt', 'added_tokens.json'];
  for (const tokenFile of tokenizerFiles) {
    const url = `${basePath}/${tokenFile}`;
    try {
      const resp = await requestUrl({ url, method: 'HEAD' });
      if (resp.status === 200) {
        const size = parseInt(resp.headers['content-length'] || '0', 10);
        files.push({ name: tokenFile, url, size });
      }
    } catch {
      // Skip missing files
    }
  }

  // Add WASM library
  if (modelSpec.modelLibUrl) {
    files.push({
      name: 'model.wasm',
      url: modelSpec.modelLibUrl,
      size: 0,
    });
  }

  return files;
}

/**
 * Check if a file is already cached
 */
async function isFileCached(url: string): Promise<boolean> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(url);
    return response !== undefined;
  } catch {
    return false;
  }
}

/**
 * Prefetch a single file and store in cache
 * Uses Obsidian's requestUrl which handles CORS and follows redirects
 */
async function prefetchFile(url: string, cache: Cache): Promise<number> {
  // Check if already cached
  const cached = await cache.match(url);
  if (cached) {
    // Already cached, skip
    const blob = await cached.blob();
    return blob.size;
  }

  // Fetch the file using Obsidian's requestUrl (handles CORS, follows redirects)
  const response = await requestUrl({ url, method: 'GET' });
  if (response.status !== 200) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  // Get the data as ArrayBuffer
  const arrayBuffer = response.arrayBuffer;
  const size = arrayBuffer.byteLength;

  // Determine content type
  const contentType = response.headers['content-type'] || 'application/octet-stream';

  // Create a Response object for Cache API
  const cacheResponse = new Response(arrayBuffer, {
    status: 200,
    statusText: 'OK',
    headers: {
      'Content-Type': contentType,
      'Content-Length': size.toString(),
    },
  });

  // Store in cache with ORIGINAL URL (not redirect URL)
  // This is the key - WebLLM will look for the original HuggingFace URL
  await cache.put(url, cacheResponse);

  return size;
}

/**
 * Prefetch all model files
 */
export async function prefetchModel(
  modelSpec: WebLLMModelSpec,
  onProgress?: (progress: PrefetchProgress) => void
): Promise<void> {
  const files = await getModelFileList(modelSpec);
  const cache = await caches.open(CACHE_NAME);

  let completedFiles = 0;
  let downloadedBytes = 0;
  const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);

  for (const file of files) {
    if (onProgress) {
      onProgress({
        totalFiles: files.length,
        completedFiles,
        currentFile: file.name,
        totalBytes,
        downloadedBytes,
        percentage: totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : (completedFiles / files.length) * 100,
      });
    }

    try {
      const fileSize = await prefetchFile(file.url, cache);
      downloadedBytes += fileSize;
    } catch (error) {
      console.error(`[WebLLMCachePrefetcher] Failed to prefetch ${file.name}:`, error);
      // Continue with other files
    }

    completedFiles++;
  }

  if (onProgress) {
    onProgress({
      totalFiles: files.length,
      completedFiles: files.length,
      currentFile: 'Complete',
      totalBytes,
      downloadedBytes,
      percentage: 100,
    });
  }
}

/**
 * Check if a model is fully prefetched
 */
export async function isModelPrefetched(modelSpec: WebLLMModelSpec): Promise<boolean> {
  try {
    const files = await getModelFileList(modelSpec);

    for (const file of files) {
      if (!(await isFileCached(file.url))) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Clear prefetched model from cache
 */
export async function clearPrefetchedModel(modelSpec: WebLLMModelSpec): Promise<void> {
  const files = await getModelFileList(modelSpec);
  const cache = await caches.open(CACHE_NAME);

  for (const file of files) {
    await cache.delete(file.url);
  }
}

/**
 * Clear all prefetched data
 */
export async function clearAllPrefetchedData(): Promise<void> {
  await caches.delete(CACHE_NAME);
}
