import { OpenAIRealtimeVoiceSession } from '../../src/services/realtimeVoice/OpenAIRealtimeVoiceSession';
import type { ResolvedRealtimeVoiceSessionRequest } from '../../src/services/realtimeVoice/RealtimeVoiceSessionTypes';

type TestableOpenAIRealtimeVoiceSession = OpenAIRealtimeVoiceSession & {
  handleServerEvent: (rawData: unknown) => void;
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
      delta: 'Hello ',
    }));
    session.handleServerEvent(JSON.stringify({
      type: 'response.output_audio_transcript.done',
      transcript: 'Hello there',
    }));

    expect(onAssistantTranscriptDelta).toHaveBeenCalledWith('Hello ');
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
});
