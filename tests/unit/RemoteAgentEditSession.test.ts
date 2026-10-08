import { RemoteAgentEditSession } from '../../src/settings/remoteAgents/RemoteAgentEditSession';
import { normalizeRemoteAgentBaseUrl } from '../../src/services/remoteAgents/HermesConnector';
import type { RemoteAgentConnection, RemoteAgentProbe } from '../../src/services/remoteAgents/types';

const connection = (): RemoteAgentConnection => ({ id: 'hermes-home', connector: 'hermes', displayName: 'My Hermes', baseUrl: 'https://hermes.example/v1', apiKey: 'old-key', enabled: true });
const ready = (): RemoteAgentProbe => ({ connected: true, runsAvailable: true, durableIdempotency: true, checkedAt: 1 });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Remote agent editor', () => {
  it('does not expose unsaved key or description edits to saved settings', () => {
    const saved = connection();
    const editor = new RemoteAgentEditSession(saved, jest.fn(), normalizeRemoteAgentBaseUrl, jest.fn());
    editor.update({ apiKey: '', description: 'General-purpose help' });
    expect(saved.apiKey).toBe('old-key');
    expect(saved.description).toBeUndefined();
  });

  it('ignores a successful test after the URL or key is edited', async () => {
    const probe = deferred<RemoteAgentProbe>();
    const editor = new RemoteAgentEditSession(connection(), jest.fn(), normalizeRemoteAgentBaseUrl, () => probe.promise);
    const test = editor.testConnection();
    editor.update({ apiKey: '' });
    probe.resolve(ready());
    expect(await test).toBeNull();
  });

  it('ignores a failed test after the editor is closed', async () => {
    let reject!: (error: Error) => void;
    const probe = new Promise<RemoteAgentProbe>((_resolve, fail) => { reject = fail; });
    const editor = new RemoteAgentEditSession(connection(), jest.fn(), normalizeRemoteAgentBaseUrl, () => probe);
    const test = editor.testConnection();
    editor.close();
    reject(new Error('Network failed'));
    expect(await test).toBeNull();
  });

  it('serializes saves so an earlier key cannot overwrite a later clear', async () => {
    const first = deferred<void>();
    const stored: string[] = [];
    const persist = jest.fn(async (snapshot: RemoteAgentConnection) => {
      if (snapshot.apiKey === 'old-key') await first.promise;
      stored.push(snapshot.apiKey ?? '');
    });
    const editor = new RemoteAgentEditSession(connection(), persist, normalizeRemoteAgentBaseUrl, jest.fn());
    const oldSave = editor.save();
    editor.update({ apiKey: '' });
    const clear = editor.save();
    first.resolve();
    await Promise.all([oldSave, clear]);
    expect(stored).toEqual(['old-key', '']);
  });

  it('rejects invalid drafts without replacing settings and preserves the stable ID', async () => {
    const persist = jest.fn(async () => undefined);
    const editor = new RemoteAgentEditSession(connection(), persist, normalizeRemoteAgentBaseUrl, jest.fn());
    editor.update({ baseUrl: 'https:', displayName: 'Renamed' });
    await expect(editor.save()).rejects.toThrow();
    editor.update({ baseUrl: 'https://hermes.example/profiles/team/v1/' });
    await editor.save();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ id: 'hermes-home', displayName: 'Renamed', baseUrl: 'https://hermes.example/profiles/team/v1' }));
  });

  it('does not manufacture readiness when the server exposes only chat', async () => {
    const result = { connected: true, runsAvailable: false, durableIdempotency: false, checkedAt: 1 };
    const editor = new RemoteAgentEditSession(connection(), jest.fn(), normalizeRemoteAgentBaseUrl, async () => result);
    expect(await editor.testConnection()).toEqual(result);
  });
});
