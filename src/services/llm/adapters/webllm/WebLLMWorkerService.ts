/**
 * WebLLMWorkerService
 *
 * Single Responsibility: Manage Web Worker lifecycle and postMessage communication.
 * Handles worker creation (via Blob URL for Obsidian compatibility), message routing,
 * and response streaming.
 */

import {
  WorkerMessage,
  WorkerResponse,
  ChunkResponse,
  CompleteResponse,
  ErrorResponse,
  InitProgressResponse,
  ReadyResponse,
  WebLLMError,
  WebLLMModelSpec,
} from './types';

/** Promise resolver for pending requests */
interface PendingRequest<T = any> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: number, stage: string) => void;
  onChunk?: (content: string) => void;
}

/** Event emitter for streaming responses */
type StreamCallback = (response: WorkerResponse) => void;

export class WebLLMWorkerService {
  private worker: Worker | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private streamCallbacks: Map<string, StreamCallback> = new Map();
  private isInitialized = false;
  private currentModelId: string | null = null;

  // Callback for file requests from worker (for local model loading)
  private fileRequestHandler?: (path: string) => Promise<ArrayBuffer>;

  /**
   * Initialize the Web Worker
   * Uses Blob URL pattern to work within Obsidian's restrictions
   */
  async initialize(fileHandler?: (path: string) => Promise<ArrayBuffer>): Promise<void> {
    if (this.worker) {
      return;
    }

    this.fileRequestHandler = fileHandler;

    try {
      const workerCode = this.buildWorkerCode();
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);

      this.worker = new Worker(workerUrl);
      this.setupMessageHandlers();

      // Clean up blob URL after worker starts
      URL.revokeObjectURL(workerUrl);

      this.isInitialized = true;
    } catch (error) {
      console.error('[WebLLMWorkerService] Failed to initialize worker:', error);
      throw new WebLLMError(
        'Failed to initialize WebLLM worker',
        'WORKER_ERROR',
        error
      );
    }
  }

  /**
   * Build the worker code as a string
   * This bypasses Obsidian's worker import restrictions
   */
  private buildWorkerCode(): string {
    // The worker code is inlined as a string
    // WebLLM is loaded via CDN inside the worker
    return `
// WebLLM Worker
// Handles model loading and inference in a separate thread

// Import WebLLM from CDN
importScripts('https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.78/lib/index.min.js');

let engine = null;
let isGenerating = false;

// Handle messages from main thread
self.onmessage = async function(event) {
  const message = event.data;

  try {
    switch (message.type) {
      case 'init':
        await handleInit(message);
        break;

      case 'generate':
        await handleGenerate(message);
        break;

      case 'stream':
        await handleStream(message);
        break;

      case 'abort':
        handleAbort(message);
        break;

      case 'unload':
        await handleUnload(message);
        break;

      case 'file_data':
        // Response from main thread for file request
        // Handled by pending promise in custom fetch
        break;
    }
  } catch (error) {
    self.postMessage({
      type: 'error',
      id: message.id,
      payload: {
        code: 'WORKER_ERROR',
        message: error.message || 'Unknown error',
        details: error.stack
      }
    });
  }
};

// Initialize the WebLLM engine with a model
async function handleInit(message) {
  const { modelId, modelUrl } = message.payload;

  // Progress callback
  const progressCallback = (report) => {
    self.postMessage({
      type: 'init_progress',
      id: message.id,
      payload: {
        progress: report.progress || 0,
        stage: report.text?.includes('Loading') ? 'loading' :
               report.text?.includes('Download') ? 'downloading' : 'compiling',
        message: report.text
      }
    });
  };

  try {
    // Create engine with progress tracking
    engine = await webllm.CreateMLCEngine(
      modelId,
      {
        initProgressCallback: progressCallback,
        // Custom model URL if provided
        ...(modelUrl && { modelUrl })
      }
    );

    // Get model info
    const config = engine.config || {};

    self.postMessage({
      type: 'ready',
      id: message.id,
      payload: {
        modelId: modelId,
        contextWindow: config.context_window_size || 32768,
        maxTokens: config.max_gen_len || 4096
      }
    });
  } catch (error) {
    throw new Error('Failed to initialize model: ' + error.message);
  }
}

// Generate response (non-streaming)
async function handleGenerate(message) {
  if (!engine) {
    throw new Error('Engine not initialized');
  }

  if (isGenerating) {
    throw new Error('Generation already in progress');
  }

  isGenerating = true;

  try {
    const { messages, temperature, maxTokens, topP, stopSequences } = message.payload;

    const response = await engine.chat.completions.create({
      messages: messages,
      temperature: temperature ?? 0.7,
      max_tokens: maxTokens ?? 2048,
      top_p: topP ?? 0.95,
      stop: stopSequences,
      stream: false
    });

    const choice = response.choices[0];
    const usage = response.usage || {};

    self.postMessage({
      type: 'complete',
      id: message.id,
      payload: {
        content: choice.message?.content || '',
        usage: {
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0
        },
        finishReason: choice.finish_reason || 'stop'
      }
    });
  } finally {
    isGenerating = false;
  }
}

// Generate streaming response
async function handleStream(message) {
  if (!engine) {
    throw new Error('Engine not initialized');
  }

  if (isGenerating) {
    throw new Error('Generation already in progress');
  }

  isGenerating = true;

  try {
    const { messages, temperature, maxTokens, topP, stopSequences } = message.payload;

    const stream = await engine.chat.completions.create({
      messages: messages,
      temperature: temperature ?? 0.7,
      max_tokens: maxTokens ?? 2048,
      top_p: topP ?? 0.95,
      stop: stopSequences,
      stream: true,
      stream_options: { include_usage: true }
    });

    let fullContent = '';
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let finishReason = 'stop';

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      const content = delta?.content || '';

      if (content) {
        fullContent += content;

        self.postMessage({
          type: 'chunk',
          id: message.id,
          payload: {
            content: content,
            tokenCount: fullContent.length // Approximate
          }
        });
      }

      // Capture finish reason
      if (chunk.choices[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }

      // Capture usage from final chunk
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens || 0,
          completionTokens: chunk.usage.completion_tokens || 0,
          totalTokens: chunk.usage.total_tokens || 0
        };
      }
    }

    self.postMessage({
      type: 'complete',
      id: message.id,
      payload: {
        content: fullContent,
        usage: usage,
        finishReason: finishReason
      }
    });
  } finally {
    isGenerating = false;
  }
}

// Abort current generation
function handleAbort(message) {
  if (engine && isGenerating) {
    engine.interruptGenerate();
    isGenerating = false;

    self.postMessage({
      type: 'complete',
      id: message.id,
      payload: {
        content: '',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: 'abort'
      }
    });
  }
}

// Unload model from GPU memory
async function handleUnload(message) {
  if (engine) {
    await engine.unload();
    engine = null;
  }

  self.postMessage({
    type: 'ready',
    id: message.id,
    payload: {
      modelId: null,
      contextWindow: 0,
      maxTokens: 0
    }
  });
}
`;
  }

  /**
   * Set up message handlers for worker responses
   */
  private setupMessageHandlers(): void {
    if (!this.worker) return;

    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const requestId = response.id;

      // Handle streaming callbacks
      const streamCallback = this.streamCallbacks.get(requestId);
      if (streamCallback) {
        streamCallback(response);

        // Clean up on completion or error
        if (response.type === 'complete' || response.type === 'error') {
          this.streamCallbacks.delete(requestId);
        }
        return;
      }

      // Handle pending request promises
      const pending = this.pendingRequests.get(requestId);
      if (!pending) {
        return;
      }

      switch (response.type) {
        case 'init_progress':
          if (pending.onProgress) {
            const progress = response as InitProgressResponse;
            pending.onProgress(progress.payload.progress, progress.payload.stage);
          }
          break;

        case 'ready':
          this.pendingRequests.delete(requestId);
          this.currentModelId = (response as ReadyResponse).payload.modelId;
          pending.resolve(response.payload);
          break;

        case 'complete':
          this.pendingRequests.delete(requestId);
          pending.resolve((response as CompleteResponse).payload);
          break;

        case 'error':
          this.pendingRequests.delete(requestId);
          const error = response as ErrorResponse;
          pending.reject(new WebLLMError(
            error.payload.message,
            error.payload.code,
            error.payload.details
          ));
          break;
      }
    };

    this.worker.onerror = (event: ErrorEvent) => {
      console.error('[WebLLMWorkerService] Worker error:', event);

      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new WebLLMError(
          'Worker error: ' + event.message,
          'WORKER_ERROR',
          event
        ));
      }
      this.pendingRequests.clear();
      this.streamCallbacks.clear();
    };
  }

  /**
   * Send a message to the worker and wait for response
   */
  private async sendMessage<T>(message: { type: string; payload?: any }, options?: {
    onProgress?: (progress: number, stage: string) => void;
  }): Promise<T> {
    if (!this.worker) {
      throw new WebLLMError('Worker not initialized', 'WORKER_ERROR');
    }

    const id = crypto.randomUUID();
    const fullMessage = { ...message, id };

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve,
        reject,
        onProgress: options?.onProgress,
      });

      this.worker!.postMessage(fullMessage);
    });
  }

  /**
   * Initialize a model
   */
  async initModel(
    modelSpec: WebLLMModelSpec,
    options?: {
      customUrl?: string;
      onProgress?: (progress: number, stage: string) => void;
    }
  ): Promise<{ modelId: string; contextWindow: number; maxTokens: number }> {
    return this.sendMessage({
      type: 'init',
      payload: {
        modelId: modelSpec.apiName,
        modelUrl: options?.customUrl,
        quantization: modelSpec.quantization,
      },
    }, {
      onProgress: options?.onProgress,
    });
  }

  /**
   * Generate a response (non-streaming)
   */
  async generate(
    messages: { role: string; content: string }[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      topP?: number;
      stopSequences?: string[];
    }
  ): Promise<{
    content: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    finishReason: string;
  }> {
    return this.sendMessage({
      type: 'generate',
      payload: {
        messages,
        ...options,
      },
    });
  }

  /**
   * Generate a streaming response
   * Returns an async generator that yields chunks
   */
  async *generateStream(
    messages: { role: string; content: string }[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      topP?: number;
      stopSequences?: string[];
    }
  ): AsyncGenerator<WorkerResponse, void, unknown> {
    if (!this.worker) {
      throw new WebLLMError('Worker not initialized', 'WORKER_ERROR');
    }

    const id = crypto.randomUUID();

    // Create a queue for responses
    const responseQueue: WorkerResponse[] = [];
    let resolveNext: ((value: WorkerResponse | null) => void) | null = null;
    let isDone = false;

    // Set up callback to receive responses
    this.streamCallbacks.set(id, (response) => {
      if (response.type === 'complete' || response.type === 'error') {
        isDone = true;
      }

      if (resolveNext) {
        resolveNext(response);
        resolveNext = null;
      } else {
        responseQueue.push(response);
      }
    });

    // Send the stream request
    this.worker.postMessage({
      type: 'stream',
      id,
      payload: {
        messages,
        ...options,
      },
    });

    // Yield responses as they arrive
    try {
      while (!isDone) {
        let response: WorkerResponse | null;

        if (responseQueue.length > 0) {
          response = responseQueue.shift()!;
        } else {
          // Wait for next response
          response = await new Promise<WorkerResponse | null>((resolve) => {
            resolveNext = resolve;
          });
        }

        if (response) {
          yield response;

          if (response.type === 'complete' || response.type === 'error') {
            break;
          }
        }
      }
    } finally {
      this.streamCallbacks.delete(id);
    }
  }

  /**
   * Abort current generation
   */
  async abort(): Promise<void> {
    if (!this.worker) return;

    const id = crypto.randomUUID();
    this.worker.postMessage({ type: 'abort', id });
  }

  /**
   * Unload the model from GPU memory
   */
  async unloadModel(): Promise<void> {
    if (!this.worker) return;

    await this.sendMessage({ type: 'unload', payload: {} });
    this.currentModelId = null;
  }

  /**
   * Check if a model is currently loaded
   */
  isModelLoaded(): boolean {
    return this.currentModelId !== null;
  }

  /**
   * Get the currently loaded model ID
   */
  getCurrentModelId(): string | null {
    return this.currentModelId;
  }

  /**
   * Terminate the worker
   */
  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.isInitialized = false;
      this.currentModelId = null;
      this.pendingRequests.clear();
      this.streamCallbacks.clear();
    }
  }

  /**
   * Check if worker is initialized
   */
  isReady(): boolean {
    return this.isInitialized && this.worker !== null;
  }
}
