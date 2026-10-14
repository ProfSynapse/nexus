import { OpenAIRealtimeVoiceSession } from '../../src/services/realtimeVoice/OpenAIRealtimeVoiceSession';
import type { ResolvedRealtimeVoiceSessionRequest } from '../../src/services/realtimeVoice/RealtimeVoiceSessionTypes';

type TestableOpenAIRealtimeVoiceSession = OpenAIRealtimeVoiceSession & {
  handleServerEvent: (rawData: unknown) => void;
  attachRemoteAudio: (peerConnection: RTCPeerConnection) => void;
};

describe('OpenAIRealtimeVoiceSession', () => {
  function createSession(callbacks: Partial<ResolvedRealtimeVoiceSessionRequest['callbacks']> = {}) {
    return new OpenAIRealtimeVoiceSession({
      provider: 'openai',
      model: 'gpt-realtime-2',
      voice: 'marin',
      apiKey: 'test-key',
      callbacks: {
        onStateChange: jest.fn(),
        onError: jest.fn(),
        onUserTranscript: jest.fn(),
        onAssistantTranscriptDelta: jest.fn(),
        onAssistantTranscriptCompleted: jest.fn(),
        ...callbacks,
      },
    }) as TestableOpenAIRealtimeVoiceSession;
  }

  it('emits assistant transcript deltas and completion from current OpenAI output audio transcript events', () => {
    const onAssistantTranscriptDelta = jest.fn();
    const onAssistantTranscriptCompleted = jest.fn();
    const session = createSession({
      onAssistantTranscriptDelta,
      onAssistantTranscriptCompleted,
    });

    session.handleServerEvent(JSON.stringify({
      type: 'response.output_audio_transcript.delta',
      response_id: 'response-1',
      item_id: 'item-1',
      output_index: 0,
      content_index: 0,
      delta: 'Hello ',
    }));
    session.handleServerEvent(JSON.stringify({
      type: 'response.output_audio_transcript.done',
      response_id: 'response-1',
      item_id: 'item-1',
      output_index: 0,
      content_index: 0,
      transcript: 'Hello there',
    }));

    expect(onAssistantTranscriptDelta).toHaveBeenCalledWith('Hello ');
    expect(onAssistantTranscriptCompleted).toHaveBeenCalledWith('Hello there');
  });

  it('does not emit response.done fallback when transcript completion already arrived for that response', () => {
    const onAssistantTranscriptCompleted = jest.fn();
    const session = createSession({ onAssistantTranscriptCompleted });

    session.handleServerEvent(JSON.stringify({
      type: 'response.output_audio_transcript.done',
      response_id: 'response-1',
      item_id: 'item-1',
      output_index: 0,
      content_index: 0,
      transcript: 'Hello there',
    }));
    session.handleServerEvent(JSON.stringify({
      type: 'response.done',
      response: {
        id: 'response-1',
        output: [
          {
            content: [
              { transcript: 'Hello there' },
            ],
          },
        ],
      },
    }));

    expect(onAssistantTranscriptCompleted).toHaveBeenCalledTimes(1);
    expect(onAssistantTranscriptCompleted).toHaveBeenCalledWith('Hello there');
  });

  it('uses response.done transcript fallback when available', () => {
    const onAssistantTranscriptCompleted = jest.fn();
    const session = createSession({ onAssistantTranscriptCompleted });

    session.handleServerEvent(JSON.stringify({
      type: 'response.done',
      response: {
        output: [
          {
            content: [
              { transcript: 'Fallback transcript.' },
            ],
          },
        ],
      },
    }));

    expect(onAssistantTranscriptCompleted).toHaveBeenCalledWith('Fallback transcript.');
  });
  // The output <audio> element lives for the whole session and is hidden. It
  // is attached after an awaited network request, by which time focus may be
  // in a popout or the Settings window (its own window since Obsidian 1.14);
  // closing that window would take the assistant's voice with it.
  it('attaches the hidden output audio to the main window, not the focused one', () => {
    const testWindow = window as unknown as object;
    const focusedDoc = { body: { appendChild: jest.fn() } };
    const descriptor = Object.getOwnPropertyDescriptor(testWindow, 'activeDocument');
    Object.defineProperty(testWindow, 'activeDocument', { configurable: true, get: () => focusedDoc });

    const session = createSession();
    const peerConnection = {} as RTCPeerConnection;
    try {
      session.attachRemoteAudio(peerConnection);
    } finally {
      if (descriptor) Object.defineProperty(testWindow, 'activeDocument', descriptor);
    }

    expect(focusedDoc.body.appendChild).not.toHaveBeenCalled();
    expect(window.document.body.appendChild).toHaveBeenCalledTimes(1);
    const audio = (window.document.body.appendChild as jest.Mock).mock.calls[0][0] as { tagName: string };
    expect(audio.tagName).toBe('AUDIO');

    // The node-env mock element has no media API; stop() pauses before removing.
    Object.assign(audio, { pause: jest.fn() });
    session.stop();
    expect((audio as unknown as { remove: jest.Mock }).remove).toHaveBeenCalled();
  });
});
