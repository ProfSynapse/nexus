import type { Vault } from 'obsidian';
import type { BaseAdapter } from '../adapters/BaseAdapter';

declare const providerDriverKindBrand: unique symbol;
declare const providerInstanceIdBrand: unique symbol;

/** Identifies an implementation family such as `openai` or `ollama`. */
export type ProviderDriverKind = string & {
  readonly [providerDriverKindBrand]: 'ProviderDriverKind';
};

/** Identifies one configured runtime/credential instance of a driver. */
export type ProviderInstanceId = string & {
  readonly [providerInstanceIdBrand]: 'ProviderInstanceId';
};

export type ProviderCompatibility = 'all' | 'desktop-only';

export interface ProviderInstance {
  readonly id: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly adapter: BaseAdapter;
  dispose(): Promise<void>;
}

export interface ProviderDriverCreateInput<TConfig> {
  instanceId: ProviderInstanceId;
  displayName: string;
  config: TConfig;
  vault?: Vault;
  onSettingsDirty?: () => void;
}

export interface ProviderDriver<TConfig> {
  readonly kind: ProviderDriverKind;
  readonly displayName: string;
  readonly compatibility: ProviderCompatibility;
  validateConfig(value: unknown): TConfig;
  createInstance(input: ProviderDriverCreateInput<TConfig>): Promise<ProviderInstance>;
}

function requireIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

export function providerDriverKind(value: string): ProviderDriverKind {
  return requireIdentity(value, 'Provider driver kind') as ProviderDriverKind;
}

export function providerInstanceId(value: string): ProviderInstanceId {
  return requireIdentity(value, 'Provider instance ID') as ProviderInstanceId;
}

/** v1 compatibility: every configured provider has one same-named instance. */
export function defaultProviderInstanceId(kind: ProviderDriverKind): ProviderInstanceId {
  return providerInstanceId(kind);
}
