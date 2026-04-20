/**
 * WebLLM Adapter Exports
 *
 * Native local LLM support via WebGPU
 */

// Main adapter
export { WebLLMAdapter } from './WebLLMAdapter';

// Services
export { WebLLMEngine } from './WebLLMEngine';
export { WebLLMModelManager } from './WebLLMModelManager';
export { WebLLMVRAMDetector } from './WebLLMVRAMDetector';

// Model definitions
export {
  WEBLLM_MODELS,
  HF_BASE_URL,
  MODEL_LIBS,
  getWebLLMModel,
  getModelsForVRAM,
  getBestModelForVRAM,
  getModelFileUrl,
  getModelManifestUrl,
  formatVRAMRequirement,
  getModelDisplayInfo,
} from './WebLLMModels';

// Types
export type {
  // Worker messages
  WorkerMessage,
  InitMessage,
  GenerateMessage,
  StreamMessage,
  AbortMessage,
  UnloadMessage,
  FileRequestMessage,

  // Worker responses
  WorkerResponse,
  InitProgressResponse,
  ReadyResponse,
  ChunkResponse,
  CompleteResponse,
  ErrorResponse,
  FileDataResponse,

  // Chat
  ChatMessage,

  // Model
  WebLLMModelSpec,
  InstalledModel,

  // VRAM
  VRAMInfo,

  // Settings
  WebLLMSettings,

  // State
  WebLLMStatus,
  WebLLMState,

  // Errors
  WebLLMErrorCode,

  // Download
  DownloadProgress,
  ModelManifest,
  ModelFile,
} from './types';

export { WebLLMError } from './types';
