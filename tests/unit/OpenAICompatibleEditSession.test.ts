/** Protects against late discovery overwriting edited credentials and async saves losing newer changes. */
import {
  CompatibleEndpointConfig,
  OpenAICompatibleEditSession,
} from '../../src/components/openai-compatible/OpenAICompatibleEditSession';

function config(): CompatibleEndpointConfig {
  return {
    apiKey: 'first-key', enabled: true, driverKind: 'openai-compatible',
    models: { existing: { enabled: false } },
    openaiCompatible: {
      schemaVersion: 1, displayName: 'Home models', baseUrl: 'https://models.example.com/v1',
      models: { existing: { source: 'manual' } },
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('OpenAI-compatible endpoint editor', () => {
  it('ignores discovery after the key changes, including an explicit clear', async () => {
    const response = deferred<string[]>();
    const persist = jest.fn(async () => undefined);
    const session = new OpenAICompatibleEditSession('id-1', config(), persist, () => response.promise);
    const discovery = session.connect();
    session.setApiKey('');
    await session.save();
    response.resolve(['stale-model']);
    expect(await discovery).toBe('stale');
    expect(session.draft.openaiCompatible.models).not.toHaveProperty('stale-model');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenLastCalledWith('id-1', expect.objectContaining({ apiKey: '' }));
  });

  it('does not mutate shared settings while editing and retains model choices', () => {
    const initial = config();
    const session = new OpenAICompatibleEditSession('id-1', initial, jest.fn());
    session.setModelEnabled('existing', true);
    session.setBaseUrl('https://other.example.com/proxy/v1');
    expect(initial.models?.existing.enabled).toBe(false);
    expect(initial.openaiCompatible.baseUrl).toBe('https://models.example.com/v1');
    expect(session.draft.openaiCompatible.models).toEqual({ existing: { source: 'manual' } });
    expect(session.draft.models?.existing.enabled).toBe(true);
    expect(session.draft.enabled).toBe(true);
  });

  it('preserves manual/discovered selections through an invalid intermediate URL and restoration', async () => {
    const initial = config();
    initial.openaiCompatible.models.discovered = { source: 'discovered' };
    initial.models = { ...initial.models, discovered: { enabled: true } };
    const persist = jest.fn(async () => undefined);
    const session = new OpenAICompatibleEditSession('id-1', initial, persist);
    session.setBaseUrl('https:');
    await expect(session.save()).rejects.toThrow();
    session.setBaseUrl(`${initial.openaiCompatible.baseUrl}/`);
    await session.save();
    expect(session.draft.openaiCompatible.models).toEqual(initial.openaiCompatible.models);
    expect(session.draft.models).toEqual(initial.models);
    expect(session.draft.enabled).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('id-1', expect.objectContaining({
      openaiCompatible: expect.objectContaining({ baseUrl: initial.openaiCompatible.baseUrl, models: initial.openaiCompatible.models }),
    }));
  });

  it('retains manually entered models and disabled choices during discovery', async () => {
    const session = new OpenAICompatibleEditSession('id-1', config(), jest.fn(async () => undefined), async () => ['existing', 'new-model', 'new-model']);
    expect(await session.connect()).toBe('connected');
    expect(session.draft.openaiCompatible.models).toEqual({ existing: { source: 'manual' }, 'new-model': { source: 'discovered' } });
    expect(session.draft.models?.existing.enabled).toBe(false);
    expect(session.draft.models?.['new-model'].enabled).toBe(true);
  });

  it('allows manual model setup without calling a discovery endpoint', async () => {
    const discover = jest.fn();
    const persist = jest.fn(async () => undefined);
    const session = new OpenAICompatibleEditSession('id-1', config(), persist, discover);
    session.addModel('my-model');
    await session.save();
    expect(discover).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledWith('id-1', expect.objectContaining({
      openaiCompatible: expect.objectContaining({ models: { existing: { source: 'manual' }, 'my-model': { source: 'manual' } } }),
    }));
    expect(() => session.addModel('my-model')).toThrow('already');
    expect(() => session.addModel('bad\nmodel')).toThrow('control characters');
  });

  it('serializes snapshots so older saves cannot finish after a later key clear', async () => {
    const first = deferred<void>();
    const saved: string[] = [];
    const persist = jest.fn(async (_id: string, snapshot: CompatibleEndpointConfig) => {
      if (snapshot.apiKey === 'first-key') await first.promise;
      saved.push(snapshot.apiKey);
    });
    const session = new OpenAICompatibleEditSession('id-1', config(), persist);
    const before = session.save();
    session.setApiKey('');
    const after = session.save();
    await Promise.resolve();
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(1);
    first.resolve();
    await Promise.all([before, after]);
    expect(saved).toEqual(['first-key', '']);
  });

  it('surfaces a failed save and permits retry', async () => {
    const persist = jest.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined);
    const session = new OpenAICompatibleEditSession('id-1', config(), persist);
    await expect(session.save()).rejects.toThrow('disk full');
    await expect(session.save()).resolves.toBeUndefined();
  });

  it('ignores discovery after the editor closes', async () => {
    const response = deferred<string[]>();
    const persist = jest.fn(async () => undefined);
    const session = new OpenAICompatibleEditSession('id-1', config(), persist, () => response.promise);
    const pending = session.connect();
    session.close();
    response.resolve(['late-model']);
    expect(await pending).toBe('stale');
    expect(persist).not.toHaveBeenCalled();
  });
});
