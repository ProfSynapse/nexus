import { requestUrl } from 'obsidian';
import type {
  RealtimeVoiceSession,
  ResolvedRealtimeVoiceSessionRequest,
} from './RealtimeVoiceSessionTypes';

interface ClientSecretResponse {
  value?: unknown;
}

interface RealtimeServerEvent {
  type?: unknown;
  transcript?: unknown;
  delta?: unknown;
  error?: {
    message?: unknown;
    type?: unknown;
    code?: unknown;
  };
}

const CLIENT_SECRET_ENDPOINT = 'https://api.openai.com/v1/realtime/client_secrets';
const REALTIME_CALLS_ENDPOINT = 'https://api.openai.com/v1/realtime/calls';

export class OpenAIRealtimeVoiceSession implements RealtimeVoiceSession {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private mediaStream: MediaStream | null = null;
  private outputAudio: HTMLAudioElement | null = null;
  private stopped = false;

  constructor(private readonly request: ResolvedRealtimeVoiceSessionRequest) {}

  async start(): Promise<void> {
    this.assertRuntimeSupport();
    this.stopped = false;
    this.request.callbacks.onStateChange('connecting');

    try {
      const clientSecret = await this.createClientSecret();
      if (this.stopped) {
        return;
      }

      const peerConnection = new RTCPeerConnection();
      this.peerConnection = peerConnection;
      this.attachRemoteAudio(peerConnection);

      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaStream.getAudioTracks().forEach(track => peerConnection.addTrack(track, this.mediaStream as MediaStream));

      const dataChannel = peerConnection.createDataChannel('oai-events');
      this.dataChannel = dataChannel;
      this.bindDataChannel(dataChannel);
      this.bindPeerConnection(peerConnection);

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      const offerSdp = peerConnection.localDescription?.sdp;
      if (!offerSdp) {
        throw new Error('OpenAI realtime connection did not create an SDP offer.');
      }

      const answerSdp = await this.createRealtimeCall(clientSecret, offerSdp);
      if (this.stopped) {
        return;
      }

      await peerConnection.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    } catch (error) {
      this.stop();
      const normalizedError: Error & { cause?: unknown } = new Error(this.getErrorMessage(error));
      normalizedError.cause = error;
      throw normalizedError;
    }
  }

  stop(): void {
    this.stopped = true;

    if (this.dataChannel && this.dataChannel.readyState !== 'closed') {
      this.dataChannel.close();
    }
    this.dataChannel = null;

    this.mediaStream?.getTracks().forEach(track => track.stop());
    this.mediaStream = null;

    this.peerConnection?.close();
    this.peerConnection = null;

    if (this.outputAudio) {
      this.outputAudio.pause();
      this.outputAudio.srcObject = null;
      this.outputAudio.remove();
      this.outputAudio = null;
    }
  }

  private assertRuntimeSupport(): void {
    if (typeof RTCPeerConnection === 'undefined') {
      throw new Error('WebRTC is not available in this Obsidian environment.');
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture is not available in this Obsidian environment.');
    }
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
          type: 'realtime',
          model: this.request.model,
          instructions: this.request.instructions || 'You are Nexus, a helpful voice assistant inside Obsidian.',
          audio: {
            input: {
              transcription: {
                model: 'gpt-4o-mini-transcribe',
              },
              turn_detection: {
                type: 'server_vad',
              },
            },
            output: {
              voice: this.request.voice,
            },
          },
        },
      }),
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OpenAI realtime client secret failed: HTTP ${response.status}: ${response.text || 'Unknown error'}`);
    }

    const body = response.json as ClientSecretResponse;
    if (typeof body.value !== 'string' || body.value.trim().length === 0) {
      throw new Error('OpenAI realtime client secret response did not include a usable token.');
    }

    return body.value;
  }

  private async createRealtimeCall(clientSecret: string, offerSdp: string): Promise<string> {
    const response = await requestUrl({
      url: REALTIME_CALLS_ENDPOINT,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        'Content-Type': 'application/sdp',
      },
      body: offerSdp,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OpenAI realtime call failed: HTTP ${response.status}: ${response.text || 'Unknown error'}`);
    }

    if (!response.text.trim()) {
      throw new Error('OpenAI realtime call returned an empty SDP answer.');
    }

    return response.text;
  }

  private attachRemoteAudio(peerConnection: RTCPeerConnection): void {
    const outputAudio = window.activeDocument.createElement('audio');
    outputAudio.autoplay = true;
    outputAudio.addClass('chat-live-voice-output');
    window.activeDocument.body.appendChild(outputAudio);
    this.outputAudio = outputAudio;

    peerConnection.ontrack = (event) => {
      outputAudio.srcObject = event.streams[0] ?? null;
    };
  }

  private bindPeerConnection(peerConnection: RTCPeerConnection): void {
    peerConnection.onconnectionstatechange = () => {
      if (this.stopped) {
        return;
      }

      if (peerConnection.connectionState === 'connected') {
        this.request.callbacks.onStateChange('listening');
        return;
      }

      if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected') {
        this.request.callbacks.onError(`OpenAI realtime connection ${peerConnection.connectionState}.`);
      }
    };
  }

  private bindDataChannel(dataChannel: RTCDataChannel): void {
    dataChannel.onopen = () => {
      if (!this.stopped) {
        this.request.callbacks.onStateChange('listening');
      }
    };
    dataChannel.onmessage = (event) => this.handleServerEvent(event.data);
    dataChannel.onerror = (event) => {
      this.request.callbacks.onError('OpenAI realtime data channel failed.', event);
    };
  }

  private handleServerEvent(rawData: unknown): void {
    if (this.stopped || typeof rawData !== 'string') {
      return;
    }

    let event: RealtimeServerEvent;
    try {
      event = JSON.parse(rawData) as RealtimeServerEvent;
    } catch {
      return;
    }

    const eventType = typeof event.type === 'string' ? event.type : '';
    switch (eventType) {
      case 'input_audio_buffer.speech_started':
        this.request.callbacks.onStateChange('user-speaking');
        break;
      case 'input_audio_buffer.speech_stopped':
        this.request.callbacks.onStateChange('listening');
        break;
      case 'response.audio.delta':
      case 'response.output_audio.delta':
        this.request.callbacks.onStateChange('assistant-speaking');
        break;
      case 'response.audio.done':
      case 'response.output_audio.done':
      case 'response.done':
        this.request.callbacks.onStateChange('listening');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (typeof event.transcript === 'string' && event.transcript.trim().length > 0) {
          this.request.callbacks.onUserTranscript?.(event.transcript.trim());
        }
        break;
      case 'response.audio_transcript.delta':
        if (typeof event.delta === 'string') {
          this.request.callbacks.onAssistantTranscriptDelta?.(event.delta);
        }
        break;
      case 'response.audio_transcript.done':
        if (typeof event.transcript === 'string' && event.transcript.trim().length > 0) {
          this.request.callbacks.onAssistantTranscriptCompleted?.(event.transcript.trim());
        }
        break;
      case 'error':
        this.request.callbacks.onError(this.formatRealtimeError(event));
        break;
      default:
        break;
    }
  }

  private formatRealtimeError(event: RealtimeServerEvent): string {
    const message = typeof event.error?.message === 'string'
      ? event.error.message
      : 'OpenAI realtime session reported an error.';
    const code = typeof event.error?.code === 'string' ? event.error.code : '';
    return code ? `${message} (${code})` : message;
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      return 'Microphone access was denied.';
    }

    if (error instanceof DOMException && error.name === 'NotFoundError') {
      return 'No microphone was found.';
    }

    return error instanceof Error ? error.message : 'Live voice failed to start.';
  }
}
