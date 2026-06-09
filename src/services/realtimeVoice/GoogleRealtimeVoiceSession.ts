import type {
  RealtimeVoiceSession,
  ResolvedGoogleRealtimeVoiceSessionRequest,
} from './RealtimeVoiceSessionTypes';

interface GoogleInlineData {
  data?: unknown;
  mimeType?: unknown;
}

interface GooglePart {
  inlineData?: GoogleInlineData;
  text?: unknown;
}

interface GoogleServerContent {
  generationComplete?: unknown;
  turnComplete?: unknown;
  interrupted?: unknown;
  inputTranscription?: {
    text?: unknown;
  };
  outputTranscription?: {
    text?: unknown;
  };
  modelTurn?: {
    parts?: GooglePart[];
  };
}

interface GoogleServerMessage {
  setupComplete?: unknown;
  serverContent?: GoogleServerContent;
  goAway?: {
    timeLeft?: unknown;
  };
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

const GOOGLE_SAMPLE_RATE_IN = 16000;
const GOOGLE_SAMPLE_RATE_OUT = 24000;
const GOOGLE_LIVE_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export class GoogleRealtimeVoiceSession implements RealtimeVoiceSession {
  private websocket: WebSocket | null = null;
  private mediaStream: MediaStream | null = null;
  private captureAudioContext: AudioContext | null = null;
  private playbackAudioContext: AudioContext | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  // Obsidian/Electron still relies on the simpler ScriptProcessor path here until
  // we add a dedicated AudioWorklet processor bundle for live voice capture.
  private captureProcessor: LegacyScriptProcessorNode | null = null;
  private captureSink: GainNode | null = null;
  private queuedSources = new Set<AudioBufferSourceNode>();
  private playbackCursorTime = 0;
  private currentState: 'connecting' | 'listening' | 'user-speaking' | 'assistant-speaking' | null = null;
  private assistantTurnFinishing = false;
  private configured = false;
  private stopped = false;
  private pendingUserTranscript = '';
  private lastCommittedUserTranscript = '';
  private currentAssistantTranscript = '';

  constructor(private readonly request: ResolvedGoogleRealtimeVoiceSessionRequest) {}

  async start(): Promise<void> {
    this.assertRuntimeSupport();
    this.stopped = false;
    this.configured = false;
    this.currentState = null;
    this.assistantTurnFinishing = false;
    this.emitStateChange('connecting');

    const url = `${GOOGLE_LIVE_ENDPOINT}?key=${encodeURIComponent(this.request.apiKey)}`;
    const websocket = new WebSocket(url);
    this.websocket = websocket;

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const rejectOnce = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.stop();
        const normalized = error instanceof Error ? error : new Error(String(error));
        reject(normalized);
      };

      const resolveOnce = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      websocket.onopen = () => {
        if (this.stopped) {
          return;
        }

        this.sendMessage({
          setup: {
            model: `models/${this.request.model}`,
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: this.request.voice,
                  },
                },
              },
            },
            systemInstruction: this.request.instructions
              ? { parts: [{ text: this.request.instructions }] }
              : undefined,
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        });
      };

      websocket.onerror = (event) => {
        rejectOnce(new Error(`Google live voice WebSocket failed.${event ? ' Check network or API key configuration.' : ''}`));
      };

      websocket.onclose = (event) => {
        if (this.stopped) {
          return;
        }

        const reason = event.reason?.trim();
        const message = reason
          ? `Google live voice connection closed: ${reason}`
          : `Google live voice connection closed (code ${event.code}).`;

        if (!settled) {
          rejectOnce(new Error(message));
          return;
        }

        this.request.callbacks.onError(message);
      };

      websocket.onmessage = async (event) => {
        try {
          await this.handleServerMessage(event.data);
          if (this.configured) {
            resolveOnce();
          }
        } catch (error) {
          if (!settled) {
            rejectOnce(error);
            return;
          }

          this.request.callbacks.onError(
            error instanceof Error ? error.message : 'Google live voice session failed.',
            error
          );
        }
      };
    });
  }

  stop(): void {
    this.stopped = true;
    this.configured = false;
    this.currentState = null;
    this.pendingUserTranscript = '';
    this.currentAssistantTranscript = '';
    this.assistantTurnFinishing = false;
    this.clearPlaybackQueue();

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

    if (this.captureAudioContext) {
      void this.captureAudioContext.close();
      this.captureAudioContext = null;
    }

    if (this.playbackAudioContext) {
      void this.playbackAudioContext.close();
      this.playbackAudioContext = null;
      this.playbackCursorTime = 0;
    }

    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.close();
    }
    this.websocket = null;
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

  private async startAudioCapture(): Promise<void> {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.captureAudioContext = new AudioContext({ sampleRate: GOOGLE_SAMPLE_RATE_IN });
    this.playbackAudioContext = new AudioContext();

    await Promise.all([
      this.captureAudioContext.resume(),
      this.playbackAudioContext.resume(),
    ]);

    const source = this.captureAudioContext.createMediaStreamSource(this.mediaStream);
    const createProcessor = this.getLegacyCreateScriptProcessor(this.captureAudioContext);
    const processor = createProcessor(2048, 1, 1);
    const sink = this.captureAudioContext.createGain();
    sink.gain.value = 0;

    source.connect(processor);
    processor.connect(sink);
    sink.connect(this.captureAudioContext.destination);

    processor.onaudioprocess = (event) => {
      if (this.stopped || !this.configured || !this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
        return;
      }

      const inputBuffer = event.inputBuffer;
      const channelData = inputBuffer.getChannelData(0);
      const audioBase64 = encodeFloatPcm16Base64(channelData, inputBuffer.sampleRate, GOOGLE_SAMPLE_RATE_IN);
      if (!audioBase64) {
        return;
      }

      this.emitStateChange('user-speaking');

      this.sendMessage({
        realtimeInput: {
          audio: {
            data: audioBase64,
            mimeType: 'audio/pcm;rate=16000',
          },
        },
      });
    };

    this.captureSource = source;
    this.captureProcessor = processor;
    this.captureSink = sink;
  }

  private getLegacyCreateScriptProcessor(audioContext: AudioContext): LegacyCreateScriptProcessor {
    const candidate = (audioContext as unknown as Record<string, unknown>).createScriptProcessor;
    if (typeof candidate !== 'function') {
      throw new Error('Microphone capture is not available in this Obsidian environment.');
    }
    return candidate.bind(audioContext) as LegacyCreateScriptProcessor;
  }

  private sendMessage(payload: Record<string, unknown>): void {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.websocket.send(JSON.stringify(payload));
  }

  private async handleServerMessage(rawData: unknown): Promise<void> {
    if (this.stopped) {
      return;
    }

    const messageText = await coerceMessageText(rawData);
    if (!messageText) {
      return;
    }

    const message = JSON.parse(messageText) as GoogleServerMessage;

    if (message.setupComplete !== undefined) {
      this.configured = true;
      void this.startAudioCapture()
        .then(() => {
          if (!this.stopped) {
            this.emitStateChange('listening');
          }
        })
        .catch((error) => {
          this.request.callbacks.onError(
            error instanceof Error ? error.message : 'Failed to start Google live audio capture.',
            error
          );
          this.stop();
        });
      return;
    }

    if (message.goAway && !this.stopped) {
      this.request.callbacks.onError('Google live voice session is ending soon. Stop and restart the session if needed.');
      return;
    }

    const serverContent = message.serverContent;
    if (!serverContent) {
      return;
    }

    const userTranscript = normalizeText(serverContent.inputTranscription?.text);
    if (userTranscript) {
      this.pendingUserTranscript = mergeTranscriptFragments(this.pendingUserTranscript, userTranscript).merged;
      this.emitStateChange('user-speaking');
    }

    const assistantTranscript = normalizeText(serverContent.outputTranscription?.text);
    if (assistantTranscript) {
      this.flushPendingUserTranscript();
      this.emitStateChange('assistant-speaking');
      const mergedTranscript = mergeTranscriptFragments(this.currentAssistantTranscript, assistantTranscript);
      this.currentAssistantTranscript = mergedTranscript.merged;
      if (mergedTranscript.delta) {
        this.request.callbacks.onAssistantTranscriptDelta?.(mergedTranscript.delta);
      }
    }

    const parts = serverContent.modelTurn?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const data = part.inlineData?.data;
        if (typeof data !== 'string' || data.length === 0) {
          continue;
        }
        this.flushPendingUserTranscript();
        this.emitStateChange('assistant-speaking');
        this.playAudioChunk(data);
      }
    }

    if (serverContent.interrupted === true) {
      this.assistantTurnFinishing = false;
      this.clearPlaybackQueue();
      this.emitStateChange('listening');
      return;
    }

    if (serverContent.turnComplete === true || serverContent.generationComplete === true) {
      this.finishAssistantTurn();
    }
  }

  private emitStateChange(state: 'connecting' | 'listening' | 'user-speaking' | 'assistant-speaking'): void {
    if (this.currentState === state) {
      return;
    }

    this.currentState = state;
    this.request.callbacks.onStateChange(state);
  }

  private finishAssistantTurn(): void {
    this.flushPendingUserTranscript();
    this.flushAssistantTranscript();

    if (this.queuedSources.size === 0) {
      this.assistantTurnFinishing = false;
      this.emitStateChange('listening');
      return;
    }

    this.assistantTurnFinishing = true;
  }

  private playAudioChunk(base64Data: string): void {
    if (!this.playbackAudioContext) {
      return;
    }

    const samples = decodeBase64Pcm16(base64Data);
    if (samples.length === 0) {
      return;
    }

    const buffer = this.playbackAudioContext.createBuffer(1, samples.length, GOOGLE_SAMPLE_RATE_OUT);
    const channelSamples = new Float32Array(samples.length);
    channelSamples.set(samples);
    buffer.copyToChannel(channelSamples, 0);

    const source = this.playbackAudioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playbackAudioContext.destination);

    const startTime = Math.max(this.playbackAudioContext.currentTime, this.playbackCursorTime);
    source.start(startTime);
    this.playbackCursorTime = startTime + buffer.duration;
    this.queuedSources.add(source);
    source.onended = () => {
      this.queuedSources.delete(source);
      if (this.queuedSources.size === 0 && this.playbackAudioContext) {
        this.playbackCursorTime = this.playbackAudioContext.currentTime;
      }
      if (this.queuedSources.size === 0 && this.assistantTurnFinishing && !this.stopped) {
        this.assistantTurnFinishing = false;
        this.emitStateChange('listening');
      }
    };
  }

  private clearPlaybackQueue(): void {
    for (const source of this.queuedSources) {
      try {
        source.stop();
      } catch {
        // Ignore already-stopped sources.
      }
      source.disconnect();
    }
    this.queuedSources.clear();
    if (this.playbackAudioContext) {
      this.playbackCursorTime = this.playbackAudioContext.currentTime;
    } else {
      this.playbackCursorTime = 0;
    }
  }

  private flushPendingUserTranscript(): void {
    if (!this.pendingUserTranscript || this.pendingUserTranscript === this.lastCommittedUserTranscript) {
      return;
    }

    this.request.callbacks.onUserTranscript?.(this.pendingUserTranscript);
    this.lastCommittedUserTranscript = this.pendingUserTranscript;
    this.pendingUserTranscript = '';
  }

  private flushAssistantTranscript(): void {
    const transcript = this.currentAssistantTranscript.trim();
    this.currentAssistantTranscript = '';
    if (!transcript) {
      return;
    }

    this.request.callbacks.onAssistantTranscriptCompleted?.(transcript);
  }
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function mergeTranscriptFragments(previous: string, incoming: string): { merged: string; delta: string } {
  if (!previous) {
    return { merged: incoming, delta: incoming };
  }

  if (!incoming || incoming === previous) {
    return { merged: previous, delta: '' };
  }

  if (incoming.startsWith(previous)) {
    return { merged: incoming, delta: incoming.slice(previous.length) };
  }

  if (previous.startsWith(incoming)) {
    return { merged: previous, delta: '' };
  }

  const overlap = findTranscriptOverlap(previous, incoming);
  if (overlap >= 3) {
    const delta = incoming.slice(overlap);
    return {
      merged: previous + delta,
      delta,
    };
  }

  const joiner = needsTranscriptSpace(previous, incoming) ? ' ' : '';
  return {
    merged: `${previous}${joiner}${incoming}`,
    delta: `${joiner}${incoming}`,
  };
}

function findTranscriptOverlap(previous: string, incoming: string): number {
  const maxOverlap = Math.min(previous.length, incoming.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (previous.slice(-size) === incoming.slice(0, size)) {
      return size;
    }
  }

  return 0;
}

function needsTranscriptSpace(previous: string, incoming: string): boolean {
  return !/[\s([{'"-]$/.test(previous) && !/^[\s,.;:!?)}'"-]/.test(incoming);
}

function encodeFloatPcm16Base64(samples: Float32Array, inputRate: number, targetRate: number): string {
  const resampled = inputRate === targetRate
    ? samples
    : resampleLinear(samples, inputRate, targetRate);

  if (resampled.length === 0) {
    return '';
  }

  const pcm = new Int16Array(resampled.length);
  for (let index = 0; index < resampled.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, resampled[index]));
    pcm[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }

  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function resampleLinear(samples: Float32Array, inputRate: number, targetRate: number): Float32Array {
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

function decodeBase64Pcm16(base64Data: string): Float32Array {
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  const sampleCount = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  }

  return samples;
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
