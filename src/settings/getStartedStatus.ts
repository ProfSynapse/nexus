import { App, Platform } from 'obsidian';
import type { LLMProviderConfig, LLMProviderSettings } from '../types/llm/ProviderTypes';
import { getPrimaryServerKey } from '../constants/branding';
import { supportsMCPBridge } from '../utils/platform';

type FsModule = typeof import('fs');
type PathModule = typeof import('path');

type NodeModuleMap = {
  fs: FsModule;
  path: PathModule;
};

type RuntimeRequire = <K extends keyof NodeModuleMap>(moduleName: K) => NodeModuleMap[K];

type ModuleWithRequire = {
  require: RuntimeRequire;
};

interface ClaudeDesktopConfig {
  mcpServers?: Record<string, unknown>;
}

function getGlobalValue(propertyName: string): unknown {
  return Reflect.get(globalThis as object, propertyName);
}

function isModuleWithRequire(value: unknown): value is ModuleWithRequire {
  return typeof value === 'object'
    && value !== null
    && typeof Reflect.get(value, 'require') === 'function';
}

function getRuntimeRequire(): RuntimeRequire {
  const globalRequire = getGlobalValue('require');
  if (typeof globalRequire === 'function') {
    return globalRequire as RuntimeRequire;
  }

  const runtimeModule = getGlobalValue('module');
  if (isModuleWithRequire(runtimeModule)) {
    return runtimeModule.require;
  }

  throw new Error('Node runtime is unavailable');
}

function getPathModule(): PathModule {
  return getRuntimeRequire()('path');
}

function getFsModule(): FsModule {
  return getRuntimeRequire()('fs');
}

function isClaudeDesktopConfig(value: unknown): value is ClaudeDesktopConfig {
  return typeof value === 'object' && value !== null;
}

export type ConfigStatus =
  | 'unsupported'
  | 'no-claude-folder'
  | 'no-config-file'
  | 'nexus-configured'
  | 'config-exists'
  | 'invalid-config';

export function isProviderConfigured(providerId: string, config?: LLMProviderConfig): boolean {
  if (!config?.enabled) {
    return false;
  }

  if (providerId === 'webllm') {
    return true;
  }

  return Boolean(config.apiKey);
}

export function hasConfiguredProviders(settings?: LLMProviderSettings): boolean {
  if (!settings?.providers) {
    return false;
  }

  return Object.entries(settings.providers).some(([providerId, config]) =>
    isProviderConfigured(providerId, config)
  );
}

export function getClaudeDesktopConfigPath(): string | null {
  if (!Platform.isDesktop || !supportsMCPBridge()) {
    return null;
  }

  const pathMod = getPathModule();

  if (Platform.isWin) {
    return pathMod.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
  }

  if (Platform.isMacOS) {
    return pathMod.join(
      process.env.HOME || '',
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    );
  }

  return pathMod.join(process.env.HOME || '', '.config', 'Claude', 'claude_desktop_config.json');
}

export function getConfigStatus(app: App): ConfigStatus {
  if (!Platform.isDesktop || !supportsMCPBridge()) {
    return 'unsupported';
  }

  const configPath = getClaudeDesktopConfigPath();
  if (!configPath) {
    return 'unsupported';
  }

  const nodeFs = getFsModule();
  const pathMod = getPathModule();
  const configDir = pathMod.dirname(configPath);

  if (!nodeFs.existsSync(configDir)) {
    return 'no-claude-folder';
  }

  if (!nodeFs.existsSync(configPath)) {
    return 'no-config-file';
  }

  try {
    const content = nodeFs.readFileSync(configPath, 'utf-8');
    if (!content.trim()) {
      return 'invalid-config';
    }

    const config: unknown = JSON.parse(content);
    const serverKey = getPrimaryServerKey(app.vault.getName());

    if (isClaudeDesktopConfig(config) && config.mcpServers?.[serverKey]) {
      return 'nexus-configured';
    }

    return 'config-exists';
  } catch (error) {
    console.error('[getStartedStatus] Error parsing config:', error);
    return 'invalid-config';
  }
}

export function isMCPConfigured(app: App): boolean {
  return getConfigStatus(app) === 'nexus-configured';
}
