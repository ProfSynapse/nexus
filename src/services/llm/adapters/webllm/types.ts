/**
 * WebLLM Adapter Types
 *
 * Type definitions for the WebLLM native integration.
 * Enables running LLMs locally via WebGPU with no external dependencies.
 */

// ============================================================================
// Worker Message Types (Interface Segregation - focused message types)
// ============================================================================

/** Base interface for all worker messages */
interface BaseWorkerMessage {
  id: string;
}

/** Initialize the WebLLM engine with a model */
export interface InitMessage extends BaseWorkerMessage {
  type: 'init';
  payload: {
    modelId: string;
    modelUrl?: string;
    quantization?: 'q4f16' | 'q5f16' | 'q8f16';
  };
}

/** Generate a response (non-streaming) */
export interface GenerateMessage extends BaseWorkerMessage {
  type: 'generate';
  payload: {
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    stopSequences?: string[];
  };
}

/** Generate a streaming response */
export interface StreamMessage extends BaseWorkerMessage {
  type: 'stream';
  payload: {
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    stopSequences?: string[];
  };
}

/** Abort an in-progress generation */
export interface AbortMessage extends BaseWorkerMessage {
  type: 'abort';
}

/** Unload the model from GPU memory */
export interface UnloadMessage extends BaseWorkerMessage {
  type: 'unload';
}

/** Request a file from the main thread (for local model loading) */
export interface FileRequestMessage extends BaseWorkerMessage {
  type: 'file_request';
  payload: {
    path: string;
  };
}

/** Union type for all worker messages */
export type WorkerMessage =
  | InitMessage
  | GenerateMessage
  | StreamMessage
  | AbortMessage
  | UnloadMessage
  | FileRequestMessage;

// ============================================================================
// Worker Response Types
// ============================================================================

/** Base interface for all worker responses */
interface BaseWorkerResponse {
  id: string;
}

/** Model initialization progress */
export interface InitProgressResponse extends BaseWorkerResponse {
  type: 'init_progress';
  payload: {
    progress: number; // 0-1
    stage: 'downloading' | 'loading' | 'compiling';
    message?: string;
  };
}

/** Model is ready for generation */
export interface ReadyResponse extends BaseWorkerResponse {
  type: 'ready';
  payload: {
    modelId: string;
    contextWindow: number;
    maxTokens: number;
  };
}

/** Streaming chunk */
export interface ChunkResponse extends BaseWorkerResponse {
  type: 'chunk';
  payload: {
    content: string;
    tokenCount?: number;
  };
}

/** Generation complete */
export interface CompleteResponse extends BaseWorkerResponse {
  type: 'complete';
  payload: {
    content: string;
    usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    finishReason: 'stop' | 'length' | 'abort';
  };
}

/** Error occurred */
export interface ErrorResponse extends BaseWorkerResponse {
  type: 'error';
  payload: {
    code: WebLLMErrorCode;
    message: string;
    details?: unknown;
  };
}

/** File data response (from main thread to worker) */
export interface FileDataResponse extends BaseWorkerResponse {
  type: 'file_data';
  payload: {
    path: string;
    data: ArrayBuffer;
  };
}

/** Union type for all worker responses */
export type WorkerResponse =
  | InitProgressResponse
  | ReadyResponse
  | ChunkResponse
  | CompleteResponse
  | ErrorResponse
  | FileDataResponse;

// ============================================================================
// Chat Message Types
// ============================================================================

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
}

// ============================================================================
// Model Types
// ============================================================================

export interface WebLLMModelSpec {
  id: string;
  name: string;
  provider: 'webllm';
  apiName: string;
  contextWindow: number;
  maxTokens: number;
  vramRequired: number; // GB
  quantization: 'q4f16' | 'q5f16' | 'q8f16';
  huggingFaceRepo: string;
  /**
   * URL to pre-built WASM model library.
   * Models sharing the same architecture can reuse the same library.
   * For Mistral-based models, use the pre-built Mistral library from WebLLM.
   */
  modelLibUrl?: string;
  /**
   * If true, model files are at root of repo (not in quantization subdirectory).
   * Default behavior expects files in {repo}/resolve/main/{quantization}/
   * With flatStructure: true, files are at {repo}/resolve/main/
   */
  flatStructure?: boolean;
  capabilities: {
    supportsJSON: boolean;
    supportsImages: boolean;
    supportsFunctions: boolean;
    supportsStreaming: boolean;
    supportsThinking: boolean;
  };
}

export interface InstalledModel {
  id: string;
  name: string;
  quantization: string;
  sizeBytes: number;
  installedAt: string;
  path: string;
}

// ============================================================================
// VRAM Detection Types
// ============================================================================

export interface VRAMInfo {
  available: boolean;
  estimatedVRAM: number; // GB
  gpuName?: string;
  recommendedQuantizations: ('q4f16' | 'q5f16' | 'q8f16')[];
  webGPUSupported: boolean;
}

// ============================================================================
// Settings Types
// ============================================================================

export interface WebLLMSettings {
  enabled: boolean;
  installedModel: string | null;
  quantization: 'q4f16' | 'q5f16' | 'q8f16';
  autoLoadOnStartup: boolean;
  customModelUrl?: string;
}

// ============================================================================
// Status Types
// ============================================================================

export type WebLLMStatus =
  | 'unavailable'      // WebGPU not supported
  | 'available'        // WebGPU available, no model loaded
  | 'needs_download'   // Model not installed
  | 'downloading'      // Model download in progress
  | 'loading'          // Model loading into GPU
  | 'ready'            // Model loaded and ready
  | 'generating'       // Currently generating
  | 'error';           // Error state

export interface WebLLMState {
  status: WebLLMStatus;
  loadedModel: string | null;
  downloadProgress?: number;
  loadProgress?: number;
  error?: string;
  vramInfo?: VRAMInfo;
}

// ============================================================================
// Error Types
// ============================================================================

export type WebLLMErrorCode =
  | 'WEBGPU_NOT_SUPPORTED'
  | 'INSUFFICIENT_VRAM'
  | 'MODEL_NOT_FOUND'
  | 'DOWNLOAD_FAILED'
  | 'LOAD_FAILED'
  | 'GENERATION_FAILED'
  | 'WORKER_ERROR'
  | 'MODULE_LOAD_FAILED'
  | 'ABORTED'
  | 'CONFIG_INVALID'
  | 'GPU_OOM'
  | 'WEBGPU_ERROR'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export class WebLLMError extends Error {
  constructor(
    message: string,
    public code: WebLLMErrorCode,
    public details?: unknown
  ) {
    super(message);
    this.name = 'WebLLMError';
  }
}

// ============================================================================
// Download Types
// ============================================================================

export interface DownloadProgress {
  totalBytes: number;
  downloadedBytes: number;
  percentage: number;
  currentFile: string;
  filesComplete: number;
  filesTotal: number;
  speed?: number; // bytes per second
  eta?: number; // seconds remaining
}

export interface ModelManifest {
  modelId: string;
  quantization: string;
  files: ModelFile[];
  configUrl: string;
  totalSize: number;
}

export interface ModelFile {
  name: string;
  url: string;
  size: number;
  sha256?: string;
}
