import { App, Platform } from 'obsidian';
import type { LLMProviderConfig, LLMProviderSettings } from '../types/llm/ProviderTypes';
import { getPrimaryServerKey } from '../constants/branding';
import { supportsMCPBridge } from '../utils/platform';
// eslint-disable-next-line import/no-nodejs-modules -- desktop-only config inspection uses Node fs in Electron
import * as nodeFs from 'node:fs';

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

  const joinPath = (...parts: string[]): string => parts.filter(Boolean).join('/');

  if (Platform.isWin) {
    return joinPath(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json');
  }

  if (Platform.isMacOS) {
    return joinPath(
      process.env.HOME || '',
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    );
  }

  return joinPath(process.env.HOME || '', '.config', 'Claude', 'claude_desktop_config.json');
}

export function getConfigStatus(app: App): ConfigStatus {
  if (!Platform.isDesktop || !supportsMCPBridge()) {
    return 'unsupported';
  }

  const configPath = getClaudeDesktopConfigPath();
  if (!configPath) {
    return 'unsupported';
  }

  const configDir = configPath.replace(/[\\/][^\\/]+$/, '');

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

    const config = JSON.parse(content) as unknown;
    const serverKey = getPrimaryServerKey(app.vault.getName());

    if (isRecord(config) && isRecord(config.mcpServers) && config.mcpServers[serverKey]) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
