import { App, Platform } from 'obsidian';
import type { LLMProviderConfig, LLMProviderSettings } from '../types/llm/ProviderTypes';
import { getServerKeyCandidates } from '../constants/branding';
import { supportsMCPBridge } from '../utils/platform';
import { desktopRequire } from '../utils/desktopRequire';
import type { MCPSettings } from '../types/plugin/PluginTypes';
import { hasCodexMcpServerConfig } from '../utils/codexMcpConfig';
import { LocalCliInstaller } from '../services/cli/LocalCliInstaller';

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

  if (config.driverKind === 'openai-compatible') {
    return Boolean(config.openaiCompatible?.baseUrl?.trim());
  }

  if (providerId === 'anthropic-claude-code' || providerId === 'google-gemini-cli') {
    return Boolean(config.oauth?.connected);
  }

  if (providerId === 'openai-codex' || providerId === 'github-copilot') {
    return Boolean(config.oauth?.connected && config.apiKey?.trim());
  }

  // Ollama and LM Studio store their server URL in apiKey.
  return Boolean(config.apiKey?.trim());
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
  const nodeFs = desktopRequire<typeof import('node:fs')>('node:fs');

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
    if (isRecord(config) && isRecord(config.mcpServers)) {
      const servers = config.mcpServers;
      if (getServerKeyCandidates(app.vault.getName()).some(key => Boolean(servers[key]))) {
        return 'nexus-configured';
      }
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

/** Setup can use internal chat OR external agents; neither path requires the other. */
export function shouldOpenGetStarted(app: App, settings: MCPSettings): boolean {
  if (typeof settings.getStartedOpen === 'boolean') {
    return settings.getStartedOpen;
  }
  return !hasConfiguredProviders(settings.llmProviders) && !hasExternalAgentSetup(app);
}

export function hasExternalAgentSetup(app: App): boolean {
  if (!Platform.isDesktop || !supportsMCPBridge()) {
    return false;
  }

  // Installation is enough for onboarding. Avoid status(), which probes shells
  // and runtime versions synchronously; those diagnostics belong in setup.
  try {
    const nodeFs = desktopRequire<typeof import('node:fs')>('node:fs');
    if (nodeFs.existsSync(new LocalCliInstaller().getPaths().cliJsPath)) {
      return true;
    }
  } catch {
    // An unavailable CLI path must not hide another configured setup path.
  }

  try {
    const nodeFs = desktopRequire<typeof import('node:fs')>('node:fs');
    const path = desktopRequire<typeof import('node:path')>('node:path');
    const home = Platform.isWin ? process.env.USERPROFILE || process.env.HOME || '' : process.env.HOME || '';
    const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
    const configPath = path.join(codexHome, 'config.toml');
    if (nodeFs.existsSync(configPath)) {
      const content = nodeFs.readFileSync(configPath, 'utf-8');
      if (getServerKeyCandidates(app.vault.getName()).some(key => hasCodexMcpServerConfig(content, key))) {
        return true;
      }
    }
  } catch {
    // Missing or unreadable client configuration is not a settings-render error.
  }

  try {
    return isMCPConfigured(app);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
