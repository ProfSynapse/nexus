import { __setRequestUrlMock } from 'obsidian';
import { AssemblyAIRealtimeVoiceSession } from '../../src/services/realtimeVoice/AssemblyAIRealtimeVoiceSession';
import type { ResolvedAssemblyAIRealtimeVoiceSessionRequest } from '../../src/services/realtimeVoice/RealtimeVoiceSessionTypes';

type TestableAssemblyAIRealtimeVoiceSession = AssemblyAIRealtimeVoiceSession & {
  createTemporaryToken: () => Promise<string>;
  handleServerMessage: (rawData: unknown) => Promise<void>;
  websocket: { readyState: number; send: jest.Mock } | null;
};

describe('AssemblyAIRealtimeVoiceSession', () => {
  function createSession(
    callbacks: Partial<ResolvedAssemblyAIRealtimeVoiceSessionRequest['callbacks']> = {}
  ): TestableAssemblyAIRealtimeVoiceSession {
    return new AssemblyAIRealtimeVoiceSession({
      provider: 'assemblyai',
      model: 'universal-3-5-pro',
      voice: '',
      apiKey: 'assemblyai-test-key',
      callbacks: {
        onStateChange: jest.fn(),
        onError: jest.fn(),
        onSpeechStarted: jest.fn(),
        onUserTranscript: jest.fn(),
        ...callbacks,
      },
    }) as TestableAssemblyAIRealtimeVoiceSession;
  }

  it('mints a temporary browser token with the permanent key in the header', async () => {
    const requests: Array<{ url?: string; headers?: Record<string, string> }> = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return {
        status: 200,
        json: { token: 'temporary-token' },
      };
    });

    const token = await createSession().createTemporaryToken();

    expect(token).toBe('temporary-token');
    expect(requests[0]?.url).toContain('/v3/token?expires_in_seconds=60');
    expect(requests[0]?.headers).toEqual({ Authorization: 'assemblyai-test-key' });
  });

  it('emits speech state and only commits finalized turns', async () => {
    const onStateChange = jest.fn();
    const onSpeechStarted = jest.fn();
    const onUserTranscript = jest.fn();
    const session = createSession({ onStateChange, onSpeechStarted, onUserTranscript });

    await session.handleServerMessage(JSON.stringify({ type: 'SpeechStarted' }));
    await session.handleServerMessage(JSON.stringify({
      type: 'Turn',
      turn_order: 1,
      transcript: 'Hello Nex',
      end_of_turn: false,
    }));

    expect(onSpeechStarted).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith('user-speaking');
    expect(onUserTranscript).not.toHaveBeenCalled();

    await session.handleServerMessage(JSON.stringify({
      type: 'Turn',
      turn_order: 1,
      transcript: 'Hello Nexus.',
      end_of_turn: true,
    }));

    expect(onUserTranscript).toHaveBeenCalledWith('Hello Nexus.');
    expect(onStateChange).toHaveBeenLastCalledWith('listening');
  });

  it('deduplicates repeated finalized turn events', async () => {
    const onUserTranscript = jest.fn();
    const session = createSession({ onUserTranscript });
    const turn = JSON.stringify({
      type: 'Turn',
      turn_order: 4,
      transcript: 'One completed turn.',
      end_of_turn: true,
    });

    await session.handleServerMessage(turn);
    await session.handleServerMessage(turn);

    expect(onUserTranscript).toHaveBeenCalledTimes(1);
  });

  it('truncates agent context to the length AssemblyAI accepts', () => {
    const session = createSession();
    const send = jest.fn();
    session.websocket = { readyState: WebSocket.OPEN, send };

    session.updateAgentContext('a'.repeat(5000));

    const payload = JSON.parse(send.mock.calls[0][0]);
    expect(payload.type).toBe('UpdateConfiguration');
    expect(payload.agent_context).toHaveLength(1750);
  });

  it('skips the agent context update when the socket is not open', () => {
    const session = createSession();
    const send = jest.fn();
    session.websocket = { readyState: WebSocket.CONNECTING, send };

    session.updateAgentContext('Anything at all.');

    expect(send).not.toHaveBeenCalled();
  });
});
