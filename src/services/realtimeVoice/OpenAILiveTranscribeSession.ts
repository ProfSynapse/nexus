import { requestUrl } from 'obsidian';
import type {
  RealtimeVoiceSession,
  ResolvedOpenAIRealtimeVoiceSessionRequest,
} from './RealtimeVoiceSessionTypes';
import { computeRms, encodeBase64, encodeFloatPcm16 } from './pcmAudio';

interface RealtimeTranscriptionEvent {
  type?: unknown;
  delta?: unknown;
  transcript?: unknown;
  error?: {
    message?: unknown;
  };
}

interface ClientSecretResponse {
  value?: unknown;
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

const SAMPLE_RATE = 24000;
const CLIENT_SECRET_ENDPOINT = 'https://api.openai.com/v1/realtime/client_secrets';
const REALTIME_ENDPOINT = 'wss://api.openai.com/v1/realtime?intent=transcription';

/**
 * gpt-live-transcribe rejects server-side turn detection, so the client decides
 * when a turn ends. These drive a simple energy gate: speech starts once the
 * signal clears the threshold, and the turn is committed after a stretch of
 * quiet. The minimum guards against committing a buffer the API considers too
 * short to transcribe.
 */
const SPEECH_RMS_THRESHOLD = 0.012;
const SILENCE_MS_BEFORE_COMMIT = 800;
const MIN_COMMIT_MS = 150;

/** The session prompt doubles as spoken-reply context, same role as AssemblyAI's agent_context. */
const MAX_PROMPT_CHARS = 2000;

export class OpenAILiveTranscribeSession implements RealtimeVoiceSession {
  readonly mode = 'composed' as const;

  private websocket: WebSocket | null = null;
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private captureProcessor: LegacyScriptProcessorNode | null = null;
  private captureSink: GainNode | null = null;
  private stopped = false;
  private connected = false;
  private currentState: 'connecting' | 'listening' | 'user-speaking' | null = null;
  private agentContext = '';

  private speaking = false;
  private silenceMs = 0;
  private bufferedMs = 0;

  constructor(private readonly request: ResolvedOpenAIRealtimeVoiceSessionRequest) {}

  async start(): Promise<void> {
    this.assertRuntimeSupport();
    this.stopped = false;
    this.connected = false;
    this.resetTurnState();
    this.emitStateChange('connecting');

    const clientSecret = await this.createClientSecret();
    if (this.stopped) {
      return;
    }

    const websocket = new WebSocket(REALTIME_ENDPOINT, [
      'realtime',
      `openai-insecure-api-key.${clientSecret}`,
    ]);
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

      websocket.onerror = () => {
        rejectOnce(new Error('OpenAI realtime transcription WebSocket failed. Check the API key and network connection.'));
      };

      websocket.onclose = (event) => {
        if (this.stopped) {
          return;
        }

        const reason = event.reason?.trim();
        const message = reason
          ? `OpenAI realtime transcription connection closed: ${reason}`
          : `OpenAI realtime transcription connection closed (code ${event.code}).`;
        if (!settled) {
          rejectOnce(new Error(message));
          return;
        }
        this.request.callbacks.onError(message);
      };

      websocket.onopen = () => {
        this.sendSessionUpdate();
      };

      websocket.onmessage = (event) => {
        void this.handleServerMessage(event.data)
          .then(() => {
            if (this.connected && !settled) {
              settled = true;
              resolve();
            }
          })
          .catch((error) => {
            if (!settled) {
              rejectOnce(error);
              return;
            }
            this.request.callbacks.onError(
              error instanceof Error ? error.message : 'OpenAI realtime transcription failed.',
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
    this.resetTurnState();
    this.stopAudioCapture();

    const websocket = this.websocket;
    this.websocket = null;
    if (!websocket) {
      return;
    }

    if (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING) {
      websocket.close();
    }
  }

  updateAgentContext(text: string): void {
    const context = normalizeText(text).slice(0, MAX_PROMPT_CHARS);
    if (!context) {
      return;
    }

    this.agentContext = context;
    this.sendSessionUpdate();
  }

  private sendSessionUpdate(): void {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.websocket.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: SAMPLE_RATE },
            transcription: {
              model: this.request.model,
              ...(this.buildPrompt() ? { prompt: this.buildPrompt() } : {}),
            },
          },
        },
      },
    }));
  }

  private buildPrompt(): string {
    return this.agentContext || normalizeText(this.request.instructions ?? '').slice(0, MAX_PROMPT_CHARS);
  }

  private async createClientSecret(): Promise<string> {
    const response = await requestUrl({
      url: CLIENT_SECRET_ENDPOINT,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.request.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: SAMPLE_RATE },
              transcription: { model: this.request.model },
            },
          },
        },
      }),
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `OpenAI realtime transcription token request failed: HTTP ${response.status}: ${response.text || 'Unknown error'}`
      );
    }

    const body = response.json as ClientSecretResponse;
    if (typeof body.value !== 'string' || !body.value.trim()) {
      throw new Error('OpenAI realtime transcription token response did not include a usable token.');
    }

    return body.value.trim();
  }

  private async handleServerMessage(rawData: unknown): Promise<void> {
    if (this.stopped) {
      return;
    }

    const messageText = await coerceMessageText(rawData);
    if (!messageText) {
      return;
    }

    const message = JSON.parse(messageText) as RealtimeTranscriptionEvent;
    const type = typeof message.type === 'string' ? message.type : '';

    if (type === 'session.created') {
      await this.startAudioCapture();
      this.connected = true;
      this.emitStateChange('listening');
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.delta') {
      if (normalizeText(message.delta)) {
        this.emitStateChange('user-speaking');
      }
      return;
    }

    if (type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = normalizeText(message.transcript);
      if (transcript) {
        this.request.callbacks.onUserTranscript?.(transcript);
      }
      this.emitStateChange('listening');
      return;
    }

    if (type === 'error') {
      const detail = normalizeText(message.error?.message);
      throw new Error(
        detail ? `OpenAI realtime transcription error: ${detail}` : 'OpenAI realtime transcription reported an error.'
      );
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
      const samples = inputBuffer.getChannelData(0);
      const pcm = encodeFloatPcm16(samples, inputBuffer.sampleRate, SAMPLE_RATE);
      if (pcm.byteLength === 0) {
        return;
      }

      this.websocket.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: encodeBase64(pcm),
      }));

      const chunkMs = (samples.length / inputBuffer.sampleRate) * 1000;
      this.bufferedMs += chunkMs;
      this.trackTurn(computeRms(samples), chunkMs);
    };

    this.captureSource = source;
    this.captureProcessor = processor;
    this.captureSink = sink;
  }

  /**
   * Energy-gated turn detection. The model does its own transcription but will
   * not tell us when the speaker stopped, so a turn is committed once speech has
   * been followed by a long enough stretch of quiet.
   */
  private trackTurn(rms: number, chunkMs: number): void {
    if (rms >= SPEECH_RMS_THRESHOLD) {
      if (!this.speaking) {
        this.speaking = true;
        this.request.callbacks.onSpeechStarted?.();
        this.emitStateChange('user-speaking');
      }
      this.silenceMs = 0;
      return;
    }

    if (!this.speaking) {
      return;
    }

    this.silenceMs += chunkMs;
    if (this.silenceMs >= SILENCE_MS_BEFORE_COMMIT && this.bufferedMs >= MIN_COMMIT_MS) {
      this.commitTurn();
    }
  }

  private commitTurn(): void {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.websocket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    this.resetTurnState();
  }

  private resetTurnState(): void {
    this.speaking = false;
    this.silenceMs = 0;
    this.bufferedMs = 0;
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
