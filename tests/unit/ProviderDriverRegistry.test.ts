/**
 * Failure bought: provider lifecycle regressions cannot leak instances, accept
 * mismatched identities, or leave later cleanup blocked after one disposer fails.
 * No Obsidian behavior is load-bearing here; the adapter is an inert value.
 */
import type { BaseAdapter } from '../../src/services/llm/adapters/BaseAdapter';
import {
  providerDriverKind,
  providerInstanceId,
  type ProviderDriver,
  type ProviderInstance,
} from '../../src/services/llm/providers/ProviderDriver';
import { ProviderDriverRegistry } from '../../src/services/llm/providers/ProviderDriverRegistry';

function fakeAdapter(): BaseAdapter {
  return {} as BaseAdapter;
}

function makeDriver(
  kindValue: string,
  createInstance: ProviderDriver<string>['createInstance']
): ProviderDriver<string> {
  return {
    kind: providerDriverKind(kindValue),
    displayName: kindValue,
    compatibility: 'all',
    validateConfig(value: unknown): string {
      if (typeof value !== 'string') throw new Error('config must be a string');
      return value;
    },
    createInstance,
  };
}

describe('ProviderDriverRegistry', () => {
  it('validates config and registers an instance under its explicit identity', async () => {
    const registry = new ProviderDriverRegistry();
    const kind = providerDriverKind('test-driver');
    const id = providerInstanceId('test-instance');
    const create = jest.fn(async (input): Promise<ProviderInstance> => ({
      id: input.instanceId,
      driverKind: kind,
      displayName: input.displayName,
      adapter: fakeAdapter(),
      dispose: jest.fn(async () => undefined),
    }));
    registry.registerDriver(makeDriver(kind, create));

    const instance = await registry.createInstance({
      driverKind: kind,
      instanceId: id,
      displayName: 'Test account',
      config: 'valid',
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ config: 'valid' }));
    expect(registry.getInstance(id)).toBe(instance);
    expect(registry.getDriver(kind)?.displayName).toBe('test-driver');
  });

  it('rejects invalid config before the driver factory runs', async () => {
    const registry = new ProviderDriverRegistry();
    const kind = providerDriverKind('validated');
    const create = jest.fn();
    registry.registerDriver(makeDriver(kind, create));

    await expect(registry.createInstance({
      driverKind: kind,
      instanceId: providerInstanceId('validated-default'),
      config: 42,
    })).rejects.toThrow('config must be a string');
    expect(create).not.toHaveBeenCalled();
  });

  it('disposes a driver result that violates the requested identity', async () => {
    const registry = new ProviderDriverRegistry();
    const kind = providerDriverKind('identity');
    const dispose = jest.fn(async () => undefined);
    registry.registerDriver(makeDriver(kind, async () => ({
      id: providerInstanceId('wrong-id'),
      driverKind: kind,
      displayName: 'Wrong',
      adapter: fakeAdapter(),
      dispose,
    })));

    await expect(registry.createInstance({
      driverKind: kind,
      instanceId: providerInstanceId('expected-id'),
      config: 'valid',
    })).rejects.toThrow('mismatched identity');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes every instance even when one disposer fails', async () => {
    const registry = new ProviderDriverRegistry();
    const calls: string[] = [];

    for (const name of ['first', 'second']) {
      const kind = providerDriverKind(name);
      registry.registerDriver(makeDriver(kind, async (input) => ({
        id: input.instanceId,
        driverKind: kind,
        displayName: name,
        adapter: fakeAdapter(),
        async dispose(): Promise<void> {
          calls.push(name);
          if (name === 'second') throw new Error('dispose failed');
        },
      })));
      await registry.createInstance({
        driverKind: kind,
        instanceId: providerInstanceId(name),
        config: 'valid',
      });
    }

    await expect(registry.clear()).rejects.toThrow('second: dispose failed');
    expect(calls).toEqual(['second', 'first']);
    expect(registry.getInstances()).toEqual([]);
    await expect(registry.clear()).resolves.toBeUndefined();
  });
});
