/** Guards against cross-run history recovery, false cancellation, unsafe replay and false-ready scopes.
 * Protocol fixtures verify parsing; actual browser pairing and server work require the gated live lane.
 */
import { OpenClawConnector } from '../../../src/services/remoteAgents/OpenClawConnector';
import { type OpenClawSession, type OpenClawTransport } from '../../../src/services/remoteAgents/OpenClawWebSocketTransport';
import { type RemoteAgentConnection } from '../../../src/services/remoteAgents/types';

const connection: RemoteAgentConnection = { id: 'oc', connector: 'openclaw', displayName: 'OpenClaw', baseUrl: 'wss://example.test', apiKey: 'test-secret', enabled: true };
const request = { input: 'inspect status', instructions: 'be brief', sessionId: 'agent:ops:explicit:nexus-job-1' };
const methods = ['agent', 'agent.wait', 'chat.abort', 'sessions.get', 'health'];
function fixture(handler: (method: string, params: Record<string, unknown>) => unknown, scopes = ['operator.read', 'operator.write']) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const close = jest.fn();
  const session: OpenClawSession = { hello: { features: { methods }, auth: { scopes } }, close,
    request: jest.fn(async (method, params = {}) => { calls.push({ method, params }); return handler(method, params); }) };
  const transport: OpenClawTransport = { connect: jest.fn(async () => session) };
  return { connector: new OpenClawConnector(transport), calls, close, transport };
}
const final = (id = 'job-1', reason = 'stop', timestamp = 1700000000000) => ({ role: 'assistant', __openclaw: { runId: id }, stopReason: reason, content: [{ type: 'text', text: 'verified test-secret' }], timestamp });

describe('OpenClawConnector', () => {
  test('prepares a deterministic key for the actual default agent without generation', async () => {
    const f = fixture(() => ({ defaultAgentId: 'ops' }));
    const input = { input: 'task', instructions: 'context' };
    expect(await f.connector.prepareRequest(connection, input, 'job-1')).toEqual({ ...input, sessionId: request.sessionId });
    expect(await f.connector.prepareRequest(connection, input, 'job-1')).toEqual({ ...input, sessionId: request.sessionId });
    expect(f.calls.map(c => c.method)).toEqual(['health', 'health']);
    expect(input).not.toHaveProperty('sessionId');
    expect(f.close).toHaveBeenCalledTimes(2);
  });
  test('submits the persisted identity once with no delivery or native runtime overrides', async () => {
    const f = fixture(() => ({ runId: 'job-1', status: 'accepted', sessionKey: request.sessionId }));
    expect(await f.connector.submit(connection, request, 'job-1')).toMatchObject({ runId: 'job-1', sessionId: request.sessionId, state: 'running' });
    expect(f.calls).toEqual([{ method: 'agent', params: { sessionKey: request.sessionId, idempotencyKey: 'job-1', message: request.input, extraSystemPrompt: request.instructions, deliver: false } }]);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  test('refuses submission until the prepared session key was persisted', async () => {
    const f = fixture(() => ({}));
    await expect(f.connector.submit(connection, { input: 'task' }, 'job-1')).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(f.transport.connect).not.toHaveBeenCalled();
  });
  test('never binds a new job key to a different job’s prepared session', async () => {
    const f = fixture(() => ({}));
    await expect(f.connector.prepareRequest(connection, request, 'other-job')).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(f.connector.submit(connection, request, 'other-job')).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(f.connector.get(connection, 'other-job', undefined, request)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(f.transport.connect).not.toHaveBeenCalled();
  });
  test('rejects mismatched acknowledged run and session identity as ambiguous', async () => {
    for (const body of [{ runId: 'other', status: 'accepted' }, { runId: 'job-1', sessionKey: 'agent:other:explicit:nexus-job-1', status: 'accepted' }]) {
      const f = fixture(() => body);
      await expect(f.connector.submit(connection, request, 'job-1')).rejects.toMatchObject({ code: 'PROTOCOL', submissionOutcomeUnknown: true });
      expect(f.calls).toHaveLength(1);
    }
  });
  test('recovers only terminal assistant text for this exact run; ignores tools and unrelated replies', async () => {
    const f = fixture(method => method === 'agent.wait' ? { runId: 'job-1', status: 'timeout' } : { messages: [
      final(), { ...final('other'), content: 'wrong-run' },
      { ...final(), role: 'toolResult', content: 'tool-data' },
      { ...final('job-1', 'toolUse'), content: 'partial-commentary' },
    ] });
    expect(await f.connector.get(connection, 'job-1', undefined, request)).toMatchObject({ state: 'completed', output: 'verified [redacted]', updatedAt: '2023-11-14T22:13:20.000Z' });
    expect(f.calls).toEqual([{ method: 'agent.wait', params: { runId: 'job-1', timeoutMs: 250 } }, { method: 'sessions.get', params: { key: request.sessionId, limit: 1000 } }]);
  });
  test('missing history remains unknown and never sends agent', async () => {
    const f = fixture(method => method === 'agent.wait' ? { runId: 'job-1', status: 'timeout' } : { messages: [] });
    expect(await f.connector.get(connection, 'job-1', undefined, request)).toMatchObject({ state: 'unknown', remoteStatus: 'unconfirmed' });
    expect(f.calls.some(c => c.method === 'agent')).toBe(false);
  });
  test('terminal wait text uses server evidence; empty or truncated replies need attention', async () => {
    const f = fixture(() => ({ runId: 'job-1', status: 'ok', endedAt: 1700000000000, terminalReply: { text: 'done test-secret' } }));
    expect(await f.connector.get(connection, 'job-1', undefined, request)).toMatchObject({ state: 'completed', output: 'done [redacted]' });
    expect(f.calls).toHaveLength(1);
    const empty = fixture(method => method === 'agent.wait' ? { runId: 'job-1', status: 'ok', endedAt: 1 } : { messages: [] });
    expect(await empty.connector.get(connection, 'job-1', undefined, request)).toMatchObject({ state: 'needs_attention' });
    const truncated = fixture(method => method === 'agent.wait' ? { status: 'timeout' } : { messages: [final('job-1', 'length')] });
    expect(await truncated.connector.get(connection, 'job-1', undefined, request)).toMatchObject({ state: 'needs_attention' });
  });
  test('unbounded timestamps never crash or fabricate terminal completion', async () => {
    const f = fixture(method => method === 'agent.wait' ? { runId: 'job-1', status: 'ok', endedAt: 1e99, terminalReply: { text: 'wrong' } } : { messages: [final('job-1', 'stop', 1e99)] });
    expect(await f.connector.get(connection, 'job-1', undefined, request)).toMatchObject({ state: 'completed' });
    expect(await f.connector.get(connection, 'job-1', undefined, request)).not.toHaveProperty('updatedAt');
  });
  test('stop racing completion recovers the completed reply when abort finds no active run', async () => {
    const f = fixture(method => method === 'chat.abort' ? { aborted: false, runIds: [] } : method === 'agent.wait' ? { status: 'timeout' } : { messages: [final()] });
    expect(await f.connector.cancel(connection, 'job-1', undefined, request)).toMatchObject({ state: 'completed', output: 'verified [redacted]' });
    expect(f.calls[0]).toEqual({ method: 'chat.abort', params: { runId: 'job-1', sessionKey: request.sessionId } });
  });
  test('acknowledged stop waits for terminal evidence and can recover it from history', async () => {
    const f = fixture(method => method === 'chat.abort' ? { aborted: true, runIds: ['job-1'] } : method === 'agent.wait' ? { status: 'timeout' } : { messages: [final('job-1', 'aborted')] });
    expect(await f.connector.cancel(connection, 'job-1', undefined, request)).toMatchObject({ state: 'cancelled' });
    const pending = fixture(method => method === 'chat.abort' ? { aborted: true, runIds: ['job-1'] } : method === 'agent.wait' ? { status: 'timeout' } : { messages: [] });
    expect(await pending.connector.cancel(connection, 'job-1', undefined, request)).toMatchObject({ state: 'running', remoteStatus: 'stopping' });
  });
  test('maps cancellation only from structured terminal rpc reason', async () => {
    const f = fixture(() => ({ status: 'error', endedAt: 1, stopReason: 'rpc' }));
    expect(await f.connector.get(connection, 'job-1', undefined, request)).toMatchObject({ state: 'cancelled' });
    const failed = fixture(() => ({ status: 'error', endedAt: 1, error: 'aborted mentioned by user' }));
    expect(await failed.connector.get(connection, 'job-1', undefined, request)).toMatchObject({ state: 'failed' });
  });
  test('probe requires read plus write and describes history recovery without durable replay', async () => {
    const ready = fixture(method => method === 'health' ? { defaultAgentId: 'ops' } : { messages: [] });
    expect(await ready.connector.probe(connection)).toMatchObject({ connected: true, runsAvailable: true, durableIdempotency: false, recoveryMode: 'session-history' });
    const missing = fixture(() => ({ defaultAgentId: 'ops' }), ['operator.write']);
    expect(await missing.connector.probe(connection)).toMatchObject({ runsAvailable: false });
    expect(ready.calls.map(c => c.method)).toEqual(['health', 'sessions.get']);
  });
});
