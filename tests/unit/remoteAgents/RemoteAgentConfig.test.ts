import { normalizeRemoteAgentConnectionUrl, validateRemoteAgentConnection } from '../../../src/services/remoteAgents/RemoteAgentConfig';
import { isRemoteAgentReady } from '../../../src/services/remoteAgents/types';

describe('remote agent protocol configuration', () => {
  test('preserves Hermes prefixes and converts OpenClaw web addresses to gateway transports', () => {
    expect(normalizeRemoteAgentConnectionUrl('https://host.test/team/v1/', 'hermes')).toBe('https://host.test/team/v1');
    expect(normalizeRemoteAgentConnectionUrl('https://host.test/team/', 'openclaw')).toBe('wss://host.test/team');
    expect(normalizeRemoteAgentConnectionUrl('http://127.0.0.1:18791/', 'openclaw')).toBe('ws://127.0.0.1:18791');
    expect(normalizeRemoteAgentConnectionUrl('ws://[::1]:18791', 'openclaw')).toBe('ws://[::1]:18791');
  });
  test.each(['ws://server.test', 'http://192.168.1.2:18789', 'wss://user:secret@host.test', 'wss://host.test?token=secret', 'wss://host.test/#key', 'https://host.test/v1', 'https://host.test/v1/responses', 'file:///tmp/socket'])('rejects unsafe or HTTP API gateway address %s', value => {
    expect(() => normalizeRemoteAgentConnectionUrl(value, 'openclaw')).toThrow();
  });
  test('requires valid connection identity for both protocols', () => {
    const connection = { id: 'a', connector: 'openclaw' as const, displayName: 'My agent', baseUrl: 'wss://host.test', enabled: true };
    expect(validateRemoteAgentConnection(connection)).toBe('wss://host.test');
    expect(() => validateRemoteAgentConnection({ ...connection, displayName: '' })).toThrow();
  });
  test('history availability is explicit and does not masquerade as durable replay', () => {
    const base = { connected: true, runsAvailable: true, durableIdempotency: false, checkedAt: 1 };
    expect(isRemoteAgentReady(base)).toBe(false);
    expect(isRemoteAgentReady({ ...base, recoveryMode: 'session-history' })).toBe(true);
    expect(isRemoteAgentReady({ ...base, recoveryMode: 'session-history', connected: false })).toBe(false);
    expect(isRemoteAgentReady({ ...base, durableIdempotency: true })).toBe(false);
    expect(isRemoteAgentReady({ ...base, durableIdempotency: true, idempotencyRetentionMs: 86400000 })).toBe(true);
  });
});
