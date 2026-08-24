import type { Vault } from 'obsidian';
import type {
  ProviderDriver,
  ProviderDriverKind,
  ProviderInstance,
  ProviderInstanceId,
} from './ProviderDriver';

type ErasedProviderDriver = ProviderDriver<unknown>;

export interface CreateProviderInstanceInput {
  driverKind: ProviderDriverKind;
  instanceId: ProviderInstanceId;
  displayName?: string;
  config: unknown;
  vault?: Vault;
  onSettingsDirty?: () => void;
}

function eraseDriver<TConfig>(driver: ProviderDriver<TConfig>): ErasedProviderDriver {
  return {
    kind: driver.kind,
    displayName: driver.displayName,
    compatibility: driver.compatibility,
    validateConfig: (value: unknown): unknown => driver.validateConfig(value),
    createInstance: async (input) => driver.createInstance({
      ...input,
      config: driver.validateConfig(input.config),
    }),
  };
}

/** Owns provider-driver discovery and every configured instance lifecycle. */
export class ProviderDriverRegistry {
  private readonly drivers = new Map<ProviderDriverKind, ErasedProviderDriver>();
  private readonly instances = new Map<ProviderInstanceId, ProviderInstance>();

  registerDriver<TConfig>(driver: ProviderDriver<TConfig>): void {
    if (this.drivers.has(driver.kind)) {
      throw new Error(`Provider driver '${driver.kind}' is already registered`);
    }
    this.drivers.set(driver.kind, eraseDriver(driver));
  }

  getDriver(kind: ProviderDriverKind): ProviderDriver<unknown> | undefined {
    return this.drivers.get(kind);
  }

  getDrivers(): ProviderDriver<unknown>[] {
    return Array.from(this.drivers.values());
  }

  getInstance(id: ProviderInstanceId): ProviderInstance | undefined {
    return this.instances.get(id);
  }

  getInstances(): ProviderInstance[] {
    return Array.from(this.instances.values());
  }

  async createInstance(input: CreateProviderInstanceInput): Promise<ProviderInstance> {
    if (this.instances.has(input.instanceId)) {
      throw new Error(`Provider instance '${input.instanceId}' is already registered`);
    }

    const driver = this.drivers.get(input.driverKind);
    if (!driver) {
      throw new Error(`Provider driver '${input.driverKind}' is not registered`);
    }

    const instance = await driver.createInstance({
      instanceId: input.instanceId,
      displayName: input.displayName || driver.displayName,
      config: input.config,
      vault: input.vault,
      onSettingsDirty: input.onSettingsDirty,
    });

    if (instance.id !== input.instanceId || instance.driverKind !== input.driverKind) {
      await instance.dispose();
      throw new Error(
        `Provider driver '${input.driverKind}' returned an instance with mismatched identity`
      );
    }

    this.instances.set(instance.id, instance);
    return instance;
  }

  async disposeInstance(id: ProviderInstanceId): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance) return;

    this.instances.delete(id);
    await instance.dispose();
  }

  async clear(): Promise<void> {
    const instances = Array.from(this.instances.values()).reverse();
    this.instances.clear();

    const failures: string[] = [];
    for (const instance of instances) {
      try {
        await instance.dispose();
      } catch (error) {
        failures.push(
          `${instance.id}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(`Failed to dispose provider instances: ${failures.join('; ')}`);
    }
  }
}
