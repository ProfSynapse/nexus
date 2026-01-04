/**
 * Location: src/services/embeddings/EmbeddingIframe.ts
 * Purpose: Iframe-based embedding generation using transformers.js
 *
 * This approach isolates transformers.js in a clean browser context,
 * avoiding Electron's Node.js environment pollution that causes:
 * - onnxruntime-node import errors
 * - import.meta.url undefined errors
 * - fileURLToPath scheme errors
 * - sharp module not found errors
 *
 * The iframe loads transformers.js directly from CDN in pure browser mode,
 * using IndexedDB for model caching.
 *
 * Based on Smart Connections' proven iframe sandbox approach.
 */

interface EmbeddingRequest {
  id: number;
  method: 'init' | 'embed' | 'embed_batch' | 'dispose';
  text?: string;
  texts?: string[];
}

interface EmbeddingResponse {
  id: number;
  success: boolean;
  embedding?: number[];
  embeddings?: number[][];
  error?: string;
  ready?: boolean;
}

/**
 * Iframe-based embedding engine
 *
 * Creates a sandboxed iframe that loads transformers.js from CDN,
 * completely isolated from Electron's Node.js environment.
 */
export class EmbeddingIframe {
  private iframe: HTMLIFrameElement | null = null;
  private isReady: boolean = false;
  // Init requests (id=-1) resolve with void, regular requests resolve with EmbeddingResponse
  private pendingRequests: Map<number, {
    resolve: (value: EmbeddingResponse | void) => void;
    reject: (error: Error) => void;
  }> = new Map();
  private requestId: number = 0;
  private initPromise: Promise<void> | null = null;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private blobUrl: string | null = null;

  private readonly MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
  private readonly DIMENSIONS = 384;

  /**
   * Initialize the iframe and load the embedding model
   */
  async initialize(): Promise<void> {
    if (this.isReady) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInitialize();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async doInitialize(): Promise<void> {
    // Create the iframe HTML that will load transformers.js
    const iframeHtml = this.createIframeHtml();

    // Create blob URL for the iframe (stored for cleanup)
    const blob = new Blob([iframeHtml], { type: 'text/html' });
    this.blobUrl = URL.createObjectURL(blob);

    // Create and configure iframe
    this.iframe = document.createElement('iframe');
    this.iframe.className = 'nexus-embedding-iframe-hidden';
    this.iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');

    // Set up message listener before loading iframe
    this.messageHandler = (event: MessageEvent) => {
      if (event.source !== this.iframe?.contentWindow) return;
      this.handleMessage(event.data);
    };
    window.addEventListener('message', this.messageHandler);

    // Wait for iframe to load and initialize
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Iframe initialization timeout (60s)'));
      }, 60000);

      // Store the resolve for when we get the ready message
      this.pendingRequests.set(-1, {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timeout);
          reject(err);
        }
      });

      this.iframe!.src = this.blobUrl!;
      document.body.appendChild(this.iframe!);
    });
  }

  /**
   * Create the HTML content for the iframe
   */
  private createIframeHtml(): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <script type="module">
    // Load transformers.js from CDN - pure browser mode
    import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

    // Configure for browser mode
    env.useBrowserCache = true;
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    // Disable web workers - they fail in sandboxed iframe context
    env.backends.onnx.wasm.numThreads = 1;

    let extractor = null;
    const MODEL_ID = '${this.MODEL_ID}';

    // Initialize the model
    async function initModel() {
      extractor = await pipeline('feature-extraction', MODEL_ID, { quantized: true });
      return true;
    }

    // Generate embedding for single text
    async function embed(text) {
      if (!extractor) throw new Error('Model not initialized');
      const truncated = text.length > 2000 ? text.slice(0, 2000) : text;
      const output = await extractor(truncated, { pooling: 'mean', normalize: true });
      return Array.from(output.data);
    }

    // Generate embeddings for batch of texts
    async function embedBatch(texts) {
      const results = [];
      for (const text of texts) {
        results.push(await embed(text));
      }
      return results;
    }

    // Message handler
    window.addEventListener('message', async (event) => {
      const { id, method, text, texts } = event.data;

      try {
        let result;
        switch (method) {
          case 'init':
            await initModel();
            result = { success: true };
            break;
          case 'embed':
            result = { success: true, embedding: await embed(text) };
            break;
          case 'embed_batch':
            result = { success: true, embeddings: await embedBatch(texts) };
            break;
          case 'dispose':
            extractor = null;
            result = { success: true };
            break;
          default:
            result = { success: false, error: 'Unknown method: ' + method };
        }
        parent.postMessage({ id, ...result }, '*');
      } catch (error) {
        parent.postMessage({ id, success: false, error: error.message }, '*');
      }
    });

    // Initialize and notify parent when ready
    initModel()
      .then(() => parent.postMessage({ id: -1, ready: true, success: true }, '*'))
      .catch(err => parent.postMessage({ id: -1, ready: false, success: false, error: err.message }, '*'));
  </script>
</head>
<body></body>
</html>`;
  }

  /**
   * Handle messages from the iframe
   */
  private handleMessage(data: EmbeddingResponse): void {
    const { id, success, ready, error } = data;

    // Handle initialization ready message
    if (id === -1) {
      const pending = this.pendingRequests.get(-1);
      if (pending) {
        this.pendingRequests.delete(-1);
        if (ready && success) {
          this.isReady = true;
          pending.resolve(undefined);
        } else {
          pending.reject(new Error(error || 'Iframe initialization failed'));
        }
      }
      return;
    }

    // Handle regular request responses
    const pending = this.pendingRequests.get(id);
    if (pending) {
      this.pendingRequests.delete(id);
      if (success) {
        pending.resolve(data);
      } else {
        pending.reject(new Error(error || 'Unknown error'));
      }
    }
  }

  /**
   * Send a request to the iframe and wait for response
   */
  private async sendRequest(request: Omit<EmbeddingRequest, 'id'>): Promise<EmbeddingResponse> {
    if (!this.iframe?.contentWindow) {
      throw new Error('Iframe not initialized');
    }

    const id = ++this.requestId;

    return new Promise((resolve, reject) => {
      // Cast resolve to accept void for Map compatibility (init uses void, regular requests use EmbeddingResponse)
      this.pendingRequests.set(id, { resolve: resolve as (value: EmbeddingResponse | void) => void, reject });
      this.iframe!.contentWindow!.postMessage({ id, ...request }, '*');

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  /**
   * Generate embedding for text
   */
  async generateEmbedding(text: string): Promise<Float32Array> {
    if (!this.isReady) {
      await this.initialize();
    }

    const response = await this.sendRequest({ method: 'embed', text });
    return new Float32Array(response.embedding!);
  }

  /**
   * Generate embeddings for multiple texts
   */
  async generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
    if (!this.isReady) {
      await this.initialize();
    }

    const response = await this.sendRequest({ method: 'embed_batch', texts });
    return response.embeddings!.map(e => new Float32Array(e));
  }

  /**
   * Dispose of the iframe
   */
  async dispose(): Promise<void> {
    // Remove window message listener
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }

    if (this.iframe) {
      try {
        await this.sendRequest({ method: 'dispose' });
      } catch (e) {
        // Ignore errors during disposal
      }
      this.iframe.remove();
      this.iframe = null;
    }

    // Revoke blob URL to free memory
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }

    this.isReady = false;
    this.pendingRequests.clear();
  }

  /**
   * Check if ready
   */
  ready(): boolean {
    return this.isReady;
  }

  /**
   * Get model info
   */
  getModelInfo(): { id: string; dimensions: number } {
    return {
      id: this.MODEL_ID,
      dimensions: this.DIMENSIONS
    };
  }
}
