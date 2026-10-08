import { RemoteAgentConnectionRegistry, REMOTE_AGENT_HEALTH_MAX_AGE_MS } from '../../../src/services/remoteAgents/RemoteAgentConnectionRegistry';
import type { RemoteAgentConnection, RemoteAgentConnector, RemoteAgentProbe } from '../../../src/services/remoteAgents/types';

const connection: RemoteAgentConnection = { id: 'agent-a', connector: 'hermes', displayName: 'Remote agent', baseUrl: 'https://example.test/v1', apiKey: 'secret', enabled: true };
const health = (): RemoteAgentProbe => ({ connected: true, runsAvailable: true, durableIdempotency: true, idempotencyRetentionMs: 86400000, checkedAt: Date.now() });
function connector(probe = jest.fn(async () => health())): RemoteAgentConnector {
  return { kind: 'hermes', probe, submit: jest.fn(), get: jest.fn(), cancel: jest.fn() };
}

describe('RemoteAgentConnectionRegistry', () => {
  test('only recently capability-verified enabled connections become sanitized prompt summaries', async () => {
    const fake = connector();
    const registry = new RemoteAgentConnectionRegistry(() => [connection], [fake]);
    expect(registry.getAvailable()).toEqual([]);
    await registry.refresh();
    expect(registry.getAvailable()).toEqual([{ id: 'agent-a', connector: 'hermes', displayName: 'Remote agent', description: expect.stringContaining('General-purpose') }]);
    expect(JSON.stringify(registry.getAvailable())).not.toMatch(/secret|example\.test/);
    expect(fake.submit).not.toHaveBeenCalled();
    expect(fake.get).not.toHaveBeenCalled();
  });
  test('memory-only replay, missing Runs and failed health are never available', async () => {
    for (const probe of [{ ...health(), durableIdempotency: false }, { ...health(), runsAvailable: false }, { ...health(), connected: false }]) {
      const registry = new RemoteAgentConnectionRegistry(() => [connection], [connector(jest.fn(async () => probe))]);
      await registry.refresh();
      expect(registry.getAvailable()).toEqual([]);
    }
  });
  test('OpenClaw history recovery is available without advertising durable replay', async () => {
    const config: RemoteAgentConnection = { ...connection, connector: 'openclaw', baseUrl: 'wss://gateway.test' };
    const fake: RemoteAgentConnector = { ...connector(), kind: 'openclaw', probe: jest.fn(async () => ({
      connected: true, runsAvailable: true, durableIdempotency: false, recoveryMode: 'session-history', checkedAt: Date.now(),
    })) };
    const registry = new RemoteAgentConnectionRegistry(() => [config], [fake]);
    await registry.refresh();
    expect(registry.getAvailable()).toEqual([expect.objectContaining({ connector: 'openclaw', id: config.id })]);
    expect(registry.getHealth(config.id)?.durableIdempotency).toBe(false);
    expect(fake.submit).not.toHaveBeenCalled();
    registry.cleanup();
  });
  test('expiry and URL/key changes invalidate health without a settings notification', async () => {
    let connections = [{ ...connection }];
    const registry = new RemoteAgentConnectionRegistry(() => connections, [connector()]);
    await registry.refresh();
    const time = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + REMOTE_AGENT_HEALTH_MAX_AGE_MS + 1);
    expect(registry.getAvailable()).toEqual([]);
    time.mockRestore();
    connections = [{ ...connection, apiKey: 'different-key' }];
    expect(registry.getHealth(connection.id)).toBeUndefined();
    await registry.refresh();
    connections = [{ ...connection, apiKey: 'different-key', baseUrl: 'https://another.test/v1' }];
    expect(registry.getAvailable()).toEqual([]);
  });
  test('late old-endpoint probe cannot make edited credentials available', async () => {
    let resolve!: (probe: RemoteAgentProbe) => void;
    let connections = [{ ...connection }];
    const pendingProbe = jest.fn(() => new Promise<RemoteAgentProbe>(done => { resolve = done; }));
    const registry = new RemoteAgentConnectionRegistry(() => connections, [connector(pendingProbe)]);
    const refresh = registry.refresh(connection.id);
    connections = [{ ...connection, baseUrl: 'https://new.test/v1', apiKey: 'new-secret' }];
    resolve(health());
    await refresh;
    expect(registry.getHealth(connection.id)).toBeUndefined();
    expect(registry.getAvailable()).toEqual([]);
  });
  test('rename updates summaries without confusing credential identity, deletion removes availability', async () => {
    let connections = [{ ...connection }];
    const registry = new RemoteAgentConnectionRegistry(() => connections, [connector()]);
    await registry.refresh();
    connections = [{ ...connection, displayName: 'New name', description: 'Specialist' }];
    expect(registry.getAvailable()).toEqual([{ id: connection.id, connector: 'hermes', displayName: 'New name', description: 'Specialist' }]);
    connections = [];
    expect(registry.get(connection.id)).toBeUndefined();
    expect(registry.getAvailable()).toEqual([]);
  });
  test('unsaved draft probe does not advertise it, disabled and duplicate identities stay unavailable', async () => {
    const registry = new RemoteAgentConnectionRegistry(() => [{ ...connection, enabled: false }], [connector()]);
    expect(await registry.probeDraft(connection)).toMatchObject({ connected: true });
    expect(registry.getAvailable()).toEqual([]);
    await registry.refresh(connection.id);
    expect(registry.getAvailable()).toEqual([]);
    const duplicates = new RemoteAgentConnectionRegistry(() => [connection, { ...connection, apiKey: 'other' }], [connector()]);
    expect(duplicates.get(connection.id)).toBeUndefined();
    expect(await duplicates.refresh()).toEqual([]);
  });
  test('cleanup aborts pending read-only probes and never cancels remote jobs', async () => {
    let signal: AbortSignal | undefined;
    const fake = connector(jest.fn((_connection, currentSignal) => {
      signal = currentSignal;
      return new Promise<RemoteAgentProbe>(resolve => currentSignal?.addEventListener('abort', () => resolve({ ...health(), connected: false }), { once: true }));
    }));
    const registry = new RemoteAgentConnectionRegistry(() => [connection], [fake]);
    const pending = registry.refresh();
    registry.cleanup();
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(fake.cancel).not.toHaveBeenCalled();
    expect(registry.getAvailable()).toEqual([]);
  });
  test('start polls every thirty seconds, skips overlapping work, and cleanup clears its timer', async () => {
    jest.useFakeTimers();
    let resolve!: (probe: RemoteAgentProbe) => void;
    const probe = jest.fn(() => new Promise<RemoteAgentProbe>(done => { resolve = done; }));
    const registry = new RemoteAgentConnectionRegistry(() => [connection], [connector(probe)]);
    try {
      registry.start(); registry.start();
      expect(probe).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(60_000);
      expect(probe).toHaveBeenCalledTimes(1);
      resolve(health());
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      jest.advanceTimersByTime(30_000);
      expect(probe).toHaveBeenCalledTimes(2);
      registry.cleanup();
      resolve(health());
      jest.advanceTimersByTime(60_000);
      expect(probe).toHaveBeenCalledTimes(2);
    } finally { registry.cleanup(); jest.useRealTimers(); }
  });
});
