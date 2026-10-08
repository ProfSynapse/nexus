/** Fails if socket teardown leaves requests/timers live, scopes escalate, challenges are unsigned,
 * or an ambiguous agent request is retried. Real gateway pairing is covered by the live app lane. */
import { OpenClawWebSocketTransport, type OpenClawSocket } from '../../../src/services/remoteAgents/OpenClawWebSocketTransport';
import { OpenClawDeviceIdentityProvider } from '../../../src/services/remoteAgents/OpenClawDeviceIdentity';
import { type RemoteAgentConnection } from '../../../src/services/remoteAgents/types';
const connection: RemoteAgentConnection = { id: 'oc', connector: 'openclaw', displayName: 'OpenClaw', baseUrl: 'wss://example.test', apiKey: 'secret-token', enabled: true };
class SigningIdentity extends OpenClawDeviceIdentityProvider {
  readonly challenges: Array<{ key: string; token: string; nonce: string; ts: number }> = [];
  async sign(key: string, token: string, nonce: string, ts: number) {
    this.challenges.push({ key, token, nonce, ts });
    return { id: 'device', publicKey: 'public', signature: 'signed', signedAt: ts, nonce };
  }
}
class Socket implements OpenClawSocket {
  readyState = 1;
  onmessage: WebSocket['onmessage'] = null;
  onerror: WebSocket['onerror'] = null;
  onclose: WebSocket['onclose'] = null;
  onopen: WebSocket['onopen'] = null;
  readonly frames: Array<{ id: string; method: string; params: Record<string, unknown> }> = [];
  readonly close = jest.fn(() => { this.readyState = 3; });
  autoConnect = true;
  connectError?: unknown;
  send = jest.fn((data: unknown) => {
    const frame = JSON.parse(String(data)) as { id: string; method: string; params: Record<string, unknown> };
    this.frames.push(frame);
    if (frame.method === 'connect' && this.autoConnect) queueMicrotask(() => this.emit(this.connectError
      ? { type: 'res', id: frame.id, ok: false, error: this.connectError }
      : { type: 'res', id: frame.id, ok: true, payload: { type: 'hello-ok', protocol: 4, features: { methods: ['agent'] }, auth: { scopes: ['operator.read', 'operator.write'] } } }));
  });
  emit(value: unknown) { this.onmessage?.call(this as unknown as WebSocket, { data: JSON.stringify(value) } as MessageEvent); }
  raw(data: unknown) { this.onmessage?.call(this as unknown as WebSocket, { data } as MessageEvent); }
  challenge() { this.emit({ type: 'event', event: 'connect.challenge', payload: { nonce: 'server-nonce', ts: 1700000000000 } }); }
}
function fixture(timeoutMs = 30_000) {
  const socket = new Socket(), identity = new SigningIdentity();
  const factory = jest.fn(() => { queueMicrotask(() => socket.challenge()); return socket; });
  return { socket, identity, factory, transport: new OpenClawWebSocketTransport({ createSocket: factory, identity, timeoutMs }) };
}

describe('OpenClawWebSocketTransport', () => {
  test('signs the server nonce/time and requests only read/write using explicit gateway auth', async () => {
    const f = fixture();
    const session = await f.transport.connect(connection);
    expect(f.factory).toHaveBeenCalledWith('wss://example.test');
    expect(f.identity.challenges).toEqual([{ key: 'oc:wss://example.test', token: 'secret-token', nonce: 'server-nonce', ts: 1700000000000 }]);
    expect(f.socket.frames[0].params).toMatchObject({ minProtocol: 4, maxProtocol: 4, scopes: ['operator.read', 'operator.write'], auth: { token: 'secret-token' }, device: { signature: 'signed' }, client: { displayName: 'Nexus', platform: 'obsidian' } });
    session.close();
    expect(f.socket.close).toHaveBeenCalledTimes(1);
    expect(f.socket.onmessage).toBeNull();
  });
  test('matches response IDs and ignores progress events and duplicate late results', async () => {
    const f = fixture();const session = await f.transport.connect(connection);
    const rpc = session.request('health');const id = f.socket.frames[1].id;
    f.socket.emit({ type: 'event', event: 'agent', payload: { text: 'untrusted progress' } });
    f.socket.emit({ type: 'res', id: 'other', ok: true, payload: { wrong: true } });
    f.socket.emit({ type: 'res', id, ok: true, payload: { ready: true } });
    f.socket.emit({ type: 'res', id, ok: true, payload: { ready: false } });
    expect(await rpc).toEqual({ ready: true });session.close();
  });
  test('local abort closes the socket and marks a sent agent request ambiguous without replay', async () => {
    const f = fixture();const session = await f.transport.connect(connection);
    const abort = new AbortController();const rpc = session.request('agent', { message: 'task' }, abort.signal);
    const assertion = expect(rpc).rejects.toMatchObject({ code: 'ABORTED', submissionOutcomeUnknown: true });
    abort.abort();await assertion;
    expect(f.socket.frames.filter(frame => frame.method === 'agent')).toHaveLength(1);
    expect(f.socket.close).toHaveBeenCalledTimes(1);
    session.close();expect(f.socket.close).toHaveBeenCalledTimes(1);
  });
  test.each([undefined, 'false', 'true'])('malformed matched ok=%s preserves the sent task’s uncertain outcome', async ok => {
    const f = fixture();const session = await f.transport.connect(connection);
    const rpc = session.request('agent', { message: 'task' });const id = f.socket.frames[1].id;
    const assertion = expect(rpc).rejects.toMatchObject({ code: 'PROTOCOL', submissionOutcomeUnknown: true });
    f.socket.emit({ type: 'res', id, ...(ok !== undefined ? { ok } : {}) });
    await assertion;
    expect(f.socket.close).toHaveBeenCalledTimes(1);
    expect(f.socket.frames.filter(frame => frame.method === 'agent')).toHaveLength(1);
  });
  test.each([undefined, { code: 'INVALID_REQUEST' }, { message: 'secret-token' }])('malformed rejection cannot declare a sent task rejected: %p', async error => {
    const f = fixture();const session = await f.transport.connect(connection);
    const rpc = session.request('agent');const id = f.socket.frames[1].id;
    const assertion = expect(rpc).rejects.toMatchObject({ code: 'PROTOCOL', submissionOutcomeUnknown: true });
    f.socket.emit({ type: 'res', id, ok: false, error });await assertion;
    expect(f.socket.close).toHaveBeenCalledTimes(1);
  });
  test.each([['INVALID_REQUEST', false], ['FORBIDDEN', false], ['UNAVAILABLE', true], ['FUTURE_ERROR', true]])('structured %s has uncertain submission outcome=%s', async (code, submissionOutcomeUnknown) => {
    const f = fixture();const session = await f.transport.connect(connection);const rpc = session.request('agent');
    const assertion = expect(rpc).rejects.toMatchObject({ submissionOutcomeUnknown });
    f.socket.emit({ type: 'res', id: f.socket.frames[1].id, ok: false, error: { code, message: 'secret-token Bearer remote' } });
    await assertion;session.close();
  });
  test('bounded lifecycle times out a silent request and tears down listeners', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    try {
      const f = fixture(1000);const session = await f.transport.connect(connection);
      const rpc = session.request('agent');const assertion = expect(rpc).rejects.toMatchObject({ code: 'TIMEOUT', submissionOutcomeUnknown: true });
      jest.advanceTimersByTime(1000);await assertion;
      expect(f.socket.onmessage).toBeNull();expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });
  test.each([
    ['PAIRING_REQUIRED', 'approval'], ['CONTROL_UI_ORIGIN_NOT_ALLOWED', 'app://obsidian.md'], ['AUTH_TOKEN_MISMATCH', 'authentication'],
  ])('surfaces actionable %s without echoing server credentials', async (code, message) => {
    const f = fixture();f.socket.connectError = { code: 'INVALID_REQUEST', message: 'secret-token Bearer leaked', details: { code } };
    await expect(f.transport.connect(connection)).rejects.toThrow(message);
    expect(f.socket.close).toHaveBeenCalledTimes(1);
  });
  test('invalid challenge cannot send credentials or reach a ready socket', async () => {
    const socket = new Socket();const identity = new SigningIdentity();
    const transport = new OpenClawWebSocketTransport({ identity, createSocket: () => { queueMicrotask(() => socket.emit({ type: 'event', event: 'connect.challenge', payload: { nonce: '', ts: 1 } }));return socket; } });
    await expect(transport.connect(connection)).rejects.toMatchObject({ code: 'PROTOCOL' });
    expect(socket.send).not.toHaveBeenCalled();expect(identity.challenges).toHaveLength(0);
  });
  test('malformed frames reject pending requests rather than producing blank success', async () => {
    const f = fixture();const session = await f.transport.connect(connection);const rpc = session.request('health');
    const assertion = expect(rpc).rejects.toMatchObject({ code: 'PROTOCOL' });
    f.socket.raw('{broken');await assertion;expect(f.socket.close).toHaveBeenCalledTimes(1);
  });
});
