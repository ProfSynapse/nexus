import { __setRequestUrlMock } from 'obsidian';
import { OpenAILiveTranscribeSession } from '../../src/services/realtimeVoice/OpenAILiveTranscribeSession';
import type { ResolvedOpenAIRealtimeVoiceSessionRequest } from '../../src/services/realtimeVoice/RealtimeVoiceSessionTypes';

type TestableSession = OpenAILiveTranscribeSession & {
  createClientSecret: () => Promise<string>;
  handleServerMessage: (rawData: unknown) => Promise<void>;
  trackTurn: (rms: number, chunkMs: number) => void;
  websocket: { readyState: number; send: jest.Mock } | null;
  connected: boolean;
  bufferedMs: number;
};

describe('OpenAILiveTranscribeSession', () => {
  function createSession(
    callbacks: Partial<ResolvedOpenAIRealtimeVoiceSessionRequest['callbacks']> = {}
  ): TestableSession {
    return new OpenAILiveTranscribeSession({
      provider: 'openai',
      model: 'gpt-live-transcribe',
      voice: '',
      apiKey: 'sk-test-key',
      callbacks: {
        onStateChange: jest.fn(),
        onError: jest.fn(),
        onSpeechStarted: jest.fn(),
        onUserTranscript: jest.fn(),
        ...callbacks,
      },
    }) as TestableSession;
  }

  function attachSocket(session: TestableSession): jest.Mock {
    const send = jest.fn();
    session.websocket = { readyState: WebSocket.OPEN, send };
    return send;
  }

  it('mints an ephemeral transcription-session token rather than using the raw key', async () => {
    const requests: Array<{ url?: string; body?: string; headers?: Record<string, string> }> = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return { status: 200, json: { value: 'ek_test_token' } };
    });

    const token = await createSession().createClientSecret();

    expect(token).toBe('ek_test_token');
    expect(requests[0]?.url).toBe('https://api.openai.com/v1/realtime/client_secrets');
    expect(requests[0]?.headers?.Authorization).toBe('Bearer sk-test-key');

    const body = JSON.parse(requests[0]?.body ?? '{}');
    expect(body.session.type).toBe('transcription');
    expect(body.session.audio.input.transcription.model).toBe('gpt-live-transcribe');
    // The model rejects turn_detection outright, so it must never be sent.
    expect(body.session.audio.input).not.toHaveProperty('turn_detection');
  });

  it('commits a turn after speech is followed by enough silence', () => {
    const onSpeechStarted = jest.fn();
    const session = createSession({ onSpeechStarted });
    const send = attachSocket(session);
    session.bufferedMs = 1000;

    session.trackTurn(0.4, 100);
    expect(onSpeechStarted).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();

    session.trackTurn(0.0001, 400);
    expect(send).not.toHaveBeenCalled();

    session.trackTurn(0.0001, 500);
    expect(JSON.parse(send.mock.calls[0][0]).type).toBe('input_audio_buffer.commit');
  });

  it('never commits when the mic only ever picked up silence', () => {
    const onSpeechStarted = jest.fn();
    const session = createSession({ onSpeechStarted });
    const send = attachSocket(session);
    session.bufferedMs = 5000;

    for (let i = 0; i < 50; i += 1) {
      session.trackTurn(0.0001, 100);
    }

    expect(send).not.toHaveBeenCalled();
    expect(onSpeechStarted).not.toHaveBeenCalled();
  });

  it('does not commit a buffer too short for the API to transcribe', () => {
    const session = createSession();
    const send = attachSocket(session);
    session.bufferedMs = 20;

    session.trackTurn(0.4, 10);
    session.trackTurn(0.0001, 2000);

    expect(send).not.toHaveBeenCalled();
  });

  it('emits the finalized transcript and returns to listening', async () => {
    const onUserTranscript = jest.fn();
    const onStateChange = jest.fn();
    const session = createSession({ onUserTranscript, onStateChange });

    await session.handleServerMessage(JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: '  Hello  Nexus.  ',
    }));

    expect(onUserTranscript).toHaveBeenCalledWith('Hello Nexus.');
    expect(onStateChange).toHaveBeenLastCalledWith('listening');
  });

  it('surfaces server error events', async () => {
    const session = createSession();

    await expect(session.handleServerMessage(JSON.stringify({
      type: 'error',
      error: { message: 'Something broke' },
    }))).rejects.toThrow('Something broke');
  });

  it('carries the spoken reply into the session prompt as transcription context', () => {
    const session = createSession();
    const send = attachSocket(session);

    session.updateAgentContext('The ticket number is AC-42.');

    const payload = JSON.parse(send.mock.calls[0][0]);
    expect(payload.type).toBe('session.update');
    expect(payload.session.audio.input.transcription.prompt).toBe('The ticket number is AC-42.');
  });
});
