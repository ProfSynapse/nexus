import { GoogleRealtimeVoiceSession } from '../../src/services/realtimeVoice/GoogleRealtimeVoiceSession';
import type { ResolvedGoogleRealtimeVoiceSessionRequest } from '../../src/services/realtimeVoice/RealtimeVoiceSessionTypes';

type TestableGoogleRealtimeVoiceSession = GoogleRealtimeVoiceSession & {
  handleServerMessage: (rawData: unknown) => Promise<void>;
  startAudioCapture: () => Promise<void>;
};

describe('GoogleRealtimeVoiceSession', () => {
  function createSession(callbacks: Partial<ResolvedGoogleRealtimeVoiceSessionRequest['callbacks']> = {}) {
    return new GoogleRealtimeVoiceSession({
      provider: 'google',
      model: 'gemini-3.1-flash-live-preview',
      voice: 'Kore',
      apiKey: 'test-key',
      callbacks: {
        onStateChange: jest.fn(),
        onError: jest.fn(),
        onUserTranscript: jest.fn(),
        onAssistantTranscriptDelta: jest.fn(),
        onAssistantTranscriptCompleted: jest.fn(),
        ...callbacks,
      },
    }) as TestableGoogleRealtimeVoiceSession;
  }

  it('buffers the user transcript until assistant output begins', async () => {
    const onUserTranscript = jest.fn();
    const onAssistantTranscriptDelta = jest.fn();
    const session = createSession({
      onUserTranscript,
      onAssistantTranscriptDelta,
    });

    await session.handleServerMessage(JSON.stringify({
      serverContent: {
        inputTranscription: { text: 'Hello Nexus' },
      },
    }));

    expect(onUserTranscript).not.toHaveBeenCalled();

    await session.handleServerMessage(JSON.stringify({
      serverContent: {
        outputTranscription: { text: 'Hi there' },
      },
    }));

    expect(onUserTranscript).toHaveBeenCalledWith('Hello Nexus');
    expect(onAssistantTranscriptDelta).toHaveBeenCalledWith('Hi there');
  });

  it('emits only the incremental assistant delta and completes on turnComplete', async () => {
    const onAssistantTranscriptDelta = jest.fn();
    const onAssistantTranscriptCompleted = jest.fn();
    const session = createSession({
      onAssistantTranscriptDelta,
      onAssistantTranscriptCompleted,
    });

    await session.handleServerMessage(JSON.stringify({
      serverContent: {
        outputTranscription: { text: 'Hi' },
      },
    }));
    await session.handleServerMessage(JSON.stringify({
      serverContent: {
        outputTranscription: { text: 'Hi there' },
      },
    }));
    await session.handleServerMessage(JSON.stringify({
      serverContent: {
        turnComplete: true,
      },
    }));

    expect(onAssistantTranscriptDelta).toHaveBeenNthCalledWith(1, 'Hi');
    expect(onAssistantTranscriptDelta).toHaveBeenNthCalledWith(2, ' there');
    expect(onAssistantTranscriptCompleted).toHaveBeenCalledWith('Hi there');
  });

  it('accumulates non-cumulative assistant transcript fragments instead of replacing them', async () => {
    const onAssistantTranscriptDelta = jest.fn();
    const onAssistantTranscriptCompleted = jest.fn();
    const session = createSession({
      onAssistantTranscriptDelta,
      onAssistantTranscriptCompleted,
    });

    await session.handleServerMessage(JSON.stringify({
      serverContent: {
        outputTranscription: { text: 'This' },
      },
    }));
    await session.handleServerMessage(JSON.stringify({
      serverContent: {
        outputTranscription: { text: 'is' },
      },
    }));
    await session.handleServerMessage(JSON.stringify({
      serverContent: {
        outputTranscription: { text: 'working' },
      },
    }));
    await session.handleServerMessage(JSON.stringify({
      serverContent: {
        turnComplete: true,
      },
    }));

    expect(onAssistantTranscriptDelta).toHaveBeenNthCalledWith(1, 'This');
    expect(onAssistantTranscriptDelta).toHaveBeenNthCalledWith(2, ' is');
    expect(onAssistantTranscriptDelta).toHaveBeenNthCalledWith(3, ' working');
    expect(onAssistantTranscriptCompleted).toHaveBeenCalledWith('This is working');
  });

  it('accepts blob setup frames and transitions to listening', async () => {
    const onStateChange = jest.fn();
    const session = createSession({ onStateChange });
    jest.spyOn(session, 'startAudioCapture').mockResolvedValue(undefined);

    await session.handleServerMessage(new Blob([JSON.stringify({ setupComplete: {} })], {
      type: 'application/json',
    }));
    await Promise.resolve();

    expect(onStateChange).toHaveBeenCalledWith('listening');
  });
});