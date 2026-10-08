/** Wire-contract regressions: submissions never silently retry, lose their key,
 * conflate stopping with cancelled, or expose an echoed credential in job data.
 * Fixtures model the current official Runs API; they do not prove a live Hermes install.
 */
import { __setRequestUrlMock } from '../../mocks/obsidian';
import { HermesConnector, normalizeRemoteAgentBaseUrl } from '../../../src/services/remoteAgents/HermesConnector';
import { RemoteAgentError, type RemoteAgentConnection } from '../../../src/services/remoteAgents/types';
import { jsonResponse, type CapturedRequest } from '../helpers/llmAdapterTestHarness';

const connection: RemoteAgentConnection = {
  id: 'remote-a', connector: 'hermes', displayName: 'Research agent',
  baseUrl: 'https://example.test/p/team/v1/', apiKey: 'test-secret-token', enabled: true,
};
const capabilities = {
  object: 'hermes.api_server.capabilities',
  features: { run_submission: true, run_status: true, run_stop: true,
    runs_idempotency: { supported: true, durable: true, retention_seconds: 86400 } },
};

describe('HermesConnector', () => {
  const connector = new HermesConnector();
  test('submits exactly once with the supplied durable key and exact request payload', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => { requests.push(request); return jsonResponse(202, { run_id: 'run_a', status: 'started' }); });
    expect(await connector.submit(connection, { input: 'research', instructions: 'be brief', sessionId: 'session-a' }, 'unique-task-key')).toEqual({ runId: 'run_a', state: 'running', remoteStatus: 'started' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: 'https://example.test/p/team/v1/runs', method: 'POST', headers: { Authorization: 'Bearer test-secret-token', 'Idempotency-Key': 'unique-task-key' } });
    expect(JSON.parse(requests[0].body!)).toEqual({ input: 'research', instructions: 'be brief', session_id: 'session-a' });
  });
  test('replays the same key/body and captures the original returned run ID', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => {
      requests.push(request);
      return { ...jsonResponse(202, { run_id: 'run_original', status: 'completed', replayed: true }), headers: { 'Idempotency-Replayed': 'true' } };
    });
    const request = { input: 'same task' };
    const first = await connector.submit(connection, request, 'same-key');
    const second = await connector.submit(connection, request, 'same-key');
    expect(first.runId).toBe(second.runId);
    expect(second).toMatchObject({ replayed: true, state: 'completed' });
    expect(requests[0].body).toBe(requests[1].body);
    expect(requests[0].headers?.['Idempotency-Key']).toBe(requests[1].headers?.['Idempotency-Key']);
  });
  test('polls the known run and preserves server update time without extending it locally', async () => {
    let captured: CapturedRequest | undefined;
    __setRequestUrlMock(async request => { captured = request; return jsonResponse(200, { object: 'hermes.run', run_id: 'run_a', status: 'completed', output: 'done', session_id: 'remote-session', model: 'remote-model', updated_at: 1700000000 }); });
    expect(await connector.get(connection, 'run_a')).toEqual({ runId: 'run_a', state: 'completed', remoteStatus: 'completed', output: 'done', sessionId: 'remote-session', model: 'remote-model', updatedAt: '2023-11-14T22:13:20.000Z' });
    expect(captured).toMatchObject({ method: 'GET', url: 'https://example.test/p/team/v1/runs/run_a' });
    expect(captured?.body).toBeUndefined();
  });
  test('cancel asks for stop and stays non-terminal until polling reports cancellation', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => { requests.push(request); return jsonResponse(200, { run_id: 'run_a', status: request.method === 'POST' ? 'stopping' : 'cancelled' }); });
    expect(await connector.cancel(connection, 'run_a')).toMatchObject({ state: 'running', remoteStatus: 'stopping' });
    expect(await connector.get(connection, 'run_a')).toMatchObject({ state: 'cancelled' });
    expect(requests[0]).toMatchObject({ method: 'POST', url: 'https://example.test/p/team/v1/runs/run_a/stop' });
  });
  test.each([
    ['queued', 'queued'], ['running', 'running'], ['waiting_for_approval', 'needs_attention'],
    ['interrupted', 'failed'], ['failed', 'failed'], ['future_state', 'unknown'],
  ])('maps %s as %s without inventing completion', async (remoteStatus, state) => {
    __setRequestUrlMock(async () => jsonResponse(200, { run_id: 'run_a', status: remoteStatus }));
    expect(await connector.get(connection, 'run_a')).toMatchObject({ state, remoteStatus });
  });
  test('capability probe is read-only and verifies Runs plus durable replay retention', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => { requests.push(request); return jsonResponse(200, capabilities); });
    expect(await connector.probe(connection)).toMatchObject({ connected: true, runsAvailable: true, durableIdempotency: true, idempotencyRetentionMs: 86400000 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'GET', url: 'https://example.test/p/team/v1/capabilities' });
  });
  test('memory-only replay or old capability payloads never promise restart-safe delegation', async () => {
    __setRequestUrlMock(async () => jsonResponse(200, { ...capabilities, features: { ...capabilities.features, runs_idempotency: { supported: true, durable: false, retention_seconds: 86400 } } }));
    expect(await connector.probe(connection)).toMatchObject({ connected: true, durableIdempotency: false, error: expect.stringMatching(/memory-only/) });
    __setRequestUrlMock(async () => jsonResponse(200, { object: 'hermes.api_server.capabilities', features: { run_submission: true } }));
    expect(await connector.probe(connection)).toMatchObject({ connected: true, runsAvailable: false, durableIdempotency: false });
  });
  test('auth is optional and empty keys never fabricate a Bearer token', async () => {
    let headers: CapturedRequest['headers'];
    __setRequestUrlMock(async request => { headers = request.headers; return jsonResponse(200, capabilities); });
    await connector.probe({ ...connection, apiKey: '' });
    expect(headers).not.toHaveProperty('Authorization');
  });
  test('key conflicts are definitive rejection, not an ambiguous successful submission', async () => {
    __setRequestUrlMock(async () => jsonResponse(409, { error: { code: 'idempotency_key_conflict', message: 'token test-secret-token' } }));
    await expect(connector.submit(connection, { input: 'changed' }, 'old-key')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409, submissionOutcomeUnknown: false });
  });
  test.each([400, 401, 403, 404])('HTTP %d submission rejection is definitive and safely redacted', async status => {
    let count = 0;
    __setRequestUrlMock(async () => { count++; return jsonResponse(status, { error: { message: 'Authorization: Bearer test-secret-token' } }); });
    const error = await connector.submit(connection, { input: 'task' }, 'key').catch(value => value as RemoteAgentError);
    expect(error).toMatchObject({ status, submissionOutcomeUnknown: false });
    expect(JSON.stringify(error)).not.toContain('test-secret-token');
    expect(String(error)).not.toContain('test-secret-token');
    expect(count).toBe(1);
  });
  test('server failure and lost acceptance remain ambiguous, with no automatic resubmission', async () => {
    let count = 0;
    __setRequestUrlMock(async () => { count++; throw new Error('network error with secret test-secret-token'); });
    await expect(connector.submit(connection, { input: 'task' }, 'key')).rejects.toMatchObject({ code: 'NETWORK', submissionOutcomeUnknown: true });
    expect(count).toBe(1);
    __setRequestUrlMock(async () => jsonResponse(503, { error: 'internal' }));
    await expect(connector.submit(connection, { input: 'task' }, 'key')).rejects.toMatchObject({ status: 503, submissionOutcomeUnknown: true });
    __setRequestUrlMock(async () => jsonResponse(202, { status: 'queued' }));
    await expect(connector.submit(connection, { input: 'task' }, 'key')).rejects.toMatchObject({ code: 'PROTOCOL', submissionOutcomeUnknown: true });
  });
  test('404 polling does not synthesize a replacement run', async () => {
    const requests: CapturedRequest[] = [];
    __setRequestUrlMock(async request => { requests.push(request); return jsonResponse(404, { error: { code: 'run_not_found' } }); });
    await expect(connector.get(connection, 'expired-run')).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
  });
  test('successful output and errors cannot persist an echoed configured credential', async () => {
    __setRequestUrlMock(async () => jsonResponse(200, { run_id: 'run_a', status: 'failed', output: 'echo test-secret-token', error: 'Bearer some-other-token' }));
    const run = await connector.get(connection, 'run_a');
    expect(run.output).toBe('echo [redacted]');
    expect(run.error).toBe('Bearer [redacted]');
  });
  test('bounded timeout or local stop remains ambiguous for submission', async () => {
    jest.useFakeTimers();
    __setRequestUrlMock(() => new Promise(() => {}));
    try {
      const pending = connector.submit(connection, { input: 'task' }, 'key');
      jest.advanceTimersByTime(30_000);
      await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT', submissionOutcomeUnknown: true });
    } finally { jest.useRealTimers(); }
    const controller = new AbortController();
    const stopped = connector.submit(connection, { input: 'task' }, 'key', controller.signal);
    controller.abort();
    await expect(stopped).rejects.toMatchObject({ code: 'ABORTED', submissionOutcomeUnknown: true });
  });
  test('unsafe URLs and malformed keys fail before any network call', async () => {
    let count = 0;
    __setRequestUrlMock(async () => { count++; return jsonResponse(200, capabilities); });
    expect(normalizeRemoteAgentBaseUrl('https://example.test/p/team/v1/')).toBe('https://example.test/p/team/v1');
    expect(normalizeRemoteAgentBaseUrl('http://127.0.0.1:8642/v1')).toBe('http://127.0.0.1:8642/v1');
    for (const value of ['http://192.168.1.1/v1', 'https://secret@example.test/v1', 'https://example.test/v1?key=secret', 'https://example.test/v1/runs', 'https://example.test/v1/runs/run_a', 'https://example.test/v1/capabilities']) expect(() => normalizeRemoteAgentBaseUrl(value)).toThrow();
    await expect(connector.submit(connection, { input: 'task' }, 'invalid key')).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(count).toBe(0);
  });
});
