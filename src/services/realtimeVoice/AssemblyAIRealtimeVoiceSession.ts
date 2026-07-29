import { requestUrl } from 'obsidian';
import type {
  RealtimeVoiceSession,
  ResolvedAssemblyAIRealtimeVoiceSessionRequest,
} from './RealtimeVoiceSessionTypes';

interface AssemblyAIStreamingMessage {
  type?: unknown;
  turn_order?: unknown;
  transcript?: unknown;
  end_of_turn?: unknown;
  error?: unknown;
  message?: unknown;
}

interface LegacyAudioProcessEvent extends Event {
  readonly inputBuffer: AudioBuffer;
}

interface LegacyScriptProcessorNode extends AudioNode {
  onaudioprocess: ((event: LegacyAudioProcessEvent) => void) | null;
}

type LegacyCreateScriptProcessor = (
  bufferSize: number,
  numberOfInputChannels: number,
  numberOfOutputChannels: number
) => LegacyScriptProcessorNode;

const SAMPLE_RATE = 16000;
/** AssemblyAI rejects an agent_context longer than this. */
const MAX_AGENT_CONTEXT_CHARS = 1750;
const TOKEN_ENDPOINT = 'https://streaming.assemblyai.com/v3/token?expires_in_seconds=60';
const STREAMING_ENDPOINT = 'wss://streaming.assemblyai.com/v3/ws';

export class AssemblyAIRealtimeVoiceSession implements RealtimeVoiceSession {
  readonly mode = 'composed' as const;

  private websocket: WebSocket | null = null;
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private captureProcessor: LegacyScriptProcessorNode | null = null;
  private captureSink: GainNode | null = null;
  private closeTimer: number | null = null;
  private stopped = false;
  private connected = false;
  private currentState: 'connecting' | 'listening' | 'user-speaking' | null = null;
  private finalizedTurns = new Set<string>();

  constructor(private readonly request: ResolvedAssemblyAIRealtimeVoiceSessionRequest) {}

  async start(): Promise<void> {
    this.assertRuntimeSupport();
    this.stopped = false;
    this.connected = false;
    this.finalizedTurns.clear();
    this.emitStateChange('connecting');

    const token = await this.createTemporaryToken();
    if (this.stopped) {
      return;
    }

    const query = new URLSearchParams({
      sample_rate: String(SAMPLE_RATE),
      speech_model: this.request.model,
      token,
    });
    const websocket = new WebSocket(`${STREAMING_ENDPOINT}?${query.toString()}`);
    this.websocket = websocket;

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const rejectOnce = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.stop();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const resolveOnce = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      websocket.onerror = () => {
        rejectOnce(new Error('AssemblyAI realtime WebSocket failed. Check the API key and network connection.'));
      };

      websocket.onclose = (event) => {
        if (this.stopped) {
          return;
        }

        const reason = event.reason?.trim();
        const message = reason
          ? `AssemblyAI realtime connection closed: ${reason}`
          : `AssemblyAI realtime connection closed (code ${event.code}).`;
        if (!settled) {
          rejectOnce(new Error(message));
          return;
        }
        this.request.callbacks.onError(message);
      };

      websocket.onmessage = (event) => {
        void this.handleServerMessage(event.data)
          .then(() => {
            if (this.connected) {
              resolveOnce();
            }
          })
          .catch((error) => {
            if (!settled) {
              rejectOnce(error);
              return;
            }
            this.request.callbacks.onError(
              error instanceof Error ? error.message : 'AssemblyAI realtime session failed.',
              error
            );
          });
      };
    });
  }

  stop(): void {
    this.stopped = true;
    this.connected = false;
    this.currentState = null;
    this.finalizedTurns.clear();
    this.stopAudioCapture();

    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }

    const websocket = this.websocket;
    this.websocket = null;
    if (!websocket) {
      return;
    }

    if (websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: 'Terminate' }));
      this.closeTimer = window.setTimeout(() => {
        this.closeTimer = null;
        websocket.close();
      }, 250);
      return;
    }

    if (websocket.readyState === WebSocket.CONNECTING) {
      websocket.close();
    }
  }

  updateAgentContext(text: string): void {
    const context = normalizeText(text).slice(0, MAX_AGENT_CONTEXT_CHARS);
    if (!context || !this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.websocket.send(JSON.stringify({
      type: 'UpdateConfiguration',
      agent_context: context,
    }));
  }

  private async createTemporaryToken(): Promise<string> {
    const response = await requestUrl({
      url: TOKEN_ENDPOINT,
      method: 'GET',
      headers: {
        Authorization: this.request.apiKey,
      },
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`AssemblyAI realtime token request failed: HTTP ${response.status}.`);
    }

    const body = response.json as { token?: unknown };
    if (typeof body.token !== 'string' || !body.token.trim()) {
      throw new Error('AssemblyAI realtime token response did not include a usable token.');
    }

    return body.token.trim();
  }

  private async handleServerMessage(rawData: unknown): Promise<void> {
    if (this.stopped) {
      return;
    }

    const messageText = await coerceMessageText(rawData);
    if (!messageText) {
      return;
    }

    const message = JSON.parse(messageText) as AssemblyAIStreamingMessage;
    const type = typeof message.type === 'string' ? message.type : '';

    if (type === 'Begin') {
      await this.startAudioCapture();
      this.connected = true;
      this.emitStateChange('listening');
      return;
    }

    if (type === 'SpeechStarted') {
      this.request.callbacks.onSpeechStarted?.();
      this.emitStateChange('user-speaking');
      return;
    }

    if (type === 'Turn') {
      const transcript = normalizeText(message.transcript);
      if (transcript) {
        this.emitStateChange('user-speaking');
      }

      if (message.end_of_turn === true && transcript) {
        const turnKey = getTurnKey(message, transcript);
        if (!this.finalizedTurns.has(turnKey)) {
          this.finalizedTurns.add(turnKey);
          this.request.callbacks.onUserTranscript?.(transcript);
        }
        this.emitStateChange('listening');
      }
      return;
    }

    if (type === 'Error') {
      const detail = normalizeText(message.error) || normalizeText(message.message);
      throw new Error(detail ? `AssemblyAI realtime error: ${detail}` : 'AssemblyAI realtime session reported an error.');
    }
  }

  private async startAudioCapture(): Promise<void> {
    if (this.mediaStream || this.stopped) {
      return;
    }

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    await this.audioContext.resume();

    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    const createProcessor = this.getLegacyCreateScriptProcessor(this.audioContext);
    const processor = createProcessor(4096, 1, 1);
    const sink = this.audioContext.createGain();
    sink.gain.value = 0;

    source.connect(processor);
    processor.connect(sink);
    sink.connect(this.audioContext.destination);

    processor.onaudioprocess = (event) => {
      if (this.stopped || !this.connected || !this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
        return;
      }

      const inputBuffer = event.inputBuffer;
      const pcm = encodeFloatPcm16(
        inputBuffer.getChannelData(0),
        inputBuffer.sampleRate,
        SAMPLE_RATE
      );
      if (pcm.byteLength > 0) {
        this.websocket.send(pcm);
      }
    };

    this.captureSource = source;
    this.captureProcessor = processor;
    this.captureSink = sink;
  }

  private stopAudioCapture(): void {
    if (this.captureProcessor) {
      this.captureProcessor.onaudioprocess = null;
      this.captureProcessor.disconnect();
      this.captureProcessor = null;
    }
    this.captureSource?.disconnect();
    this.captureSource = null;
    this.captureSink?.disconnect();
    this.captureSink = null;
    this.mediaStream?.getTracks().forEach(track => track.stop());
    this.mediaStream = null;

    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }
  }

  private getLegacyCreateScriptProcessor(audioContext: AudioContext): LegacyCreateScriptProcessor {
    const candidate = (audioContext as unknown as Record<string, unknown>).createScriptProcessor;
    if (typeof candidate !== 'function') {
      throw new Error('Microphone capture is not available in this Obsidian environment.');
    }
    return candidate.bind(audioContext) as LegacyCreateScriptProcessor;
  }

  private assertRuntimeSupport(): void {
    if (typeof WebSocket === 'undefined') {
      throw new Error('WebSocket is not available in this Obsidian environment.');
    }
    if (typeof AudioContext === 'undefined') {
      throw new Error('AudioContext is not available in this Obsidian environment.');
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture is not available in this Obsidian environment.');
    }
  }

  private emitStateChange(state: 'connecting' | 'listening' | 'user-speaking'): void {
    if (this.currentState === state) {
      return;
    }
    this.currentState = state;
    this.request.callbacks.onStateChange(state);
  }
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function getTurnKey(message: AssemblyAIStreamingMessage, transcript: string): string {
  if (typeof message.turn_order === 'number' || typeof message.turn_order === 'string') {
    return String(message.turn_order);
  }
  return transcript;
}

function encodeFloatPcm16(samples: Float32Array, inputRate: number, targetRate: number): ArrayBuffer {
  const resampled = inputRate === targetRate
    ? samples
    : resampleLinear(samples, inputRate, targetRate);
  const bytes = new ArrayBuffer(resampled.length * 2);
  const view = new DataView(bytes);

  for (let index = 0; index < resampled.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, resampled[index]));
    const value = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    view.setInt16(index * 2, value, true);
  }

  return bytes;
}

function resampleLinear(samples: Float32Array, inputRate: number, targetRate: number): Float32Array {
  if (samples.length === 0) {
    return new Float32Array();
  }

  const targetLength = Math.max(1, Math.round(samples.length * targetRate / inputRate));
  const result = new Float32Array(targetLength);
  const scale = inputRate / targetRate;
  for (let index = 0; index < targetLength; index += 1) {
    const position = index * scale;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const weight = position - left;
    result[index] = samples[left] + (samples[right] - samples[left]) * weight;
  }
  return result;
}

async function coerceMessageText(data: unknown): Promise<string | null> {
  if (typeof data === 'string') {
    return data;
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return data.text();
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return null;
}
