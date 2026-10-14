import { App, Platform } from 'obsidian';
import type { LLMProviderConfig, LLMProviderSettings } from '../types/llm/ProviderTypes';
import { getServerKeyCandidates } from '../constants/branding';
import { supportsMCPBridge } from '../utils/platform';
import { desktopRequire } from '../utils/desktopRequire';
import { LocalCliInstaller } from '../services/cli/LocalCliInstaller';
import {
  type McpConfigStatus,
  getAntigravityConfigPath,
  getAntigravityLegacyConfigPath,
  getCodexConfigPath,
  getCodexStatus,
  getMcpJsonStatus
} from '../utils/mcpClientConfigs';

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

export type ExternalClientId = 'claude-desktop' | 'codex' | 'antigravity';

export interface ExternalClientStatus {
  id: ExternalClientId;
  label: string;
  /** The file Connect writes. */
  configPath: string;
  /** The file that produced `status`, which Open config opens. Usually `configPath`. */
  statusPath: string;
  status: McpConfigStatus;
}

/**
 * One-click MCP clients in display order, with the state of their configs.
 * Empty on mobile and wherever the MCP bridge is unavailable.
 */
export function getExternalClientStatuses(app: App): ExternalClientStatus[] {
  if (!Platform.isDesktop || !supportsMCPBridge()) {
    return [];
  }

  const keys = getServerKeyCandidates(app.vault.getName());
  const statuses: ExternalClientStatus[] = [];
  /** `read` names `statusPath` when another file than `configPath` produced the status. */
  type Read = () => McpConfigStatus | { status: McpConfigStatus; statusPath: string };
  const add = (id: ExternalClientId, label: string, configPath: string, read: Read): void => {
    let status: McpConfigStatus;
    let path = configPath;
    try {
      const result = read();
      if ('status' in result) {
        status = result.status;
        path = result.statusPath;
      } else {
        status = result;
      }
    } catch (error) {
      console.error(`[getStartedStatus] Could not read the ${label} config:`, error);
      status = { state: 'invalid-config', stale: false };
    }
    statuses.push({ id, label, configPath, statusPath: path, status });
  };

  const claudePath = getClaudeDesktopConfigPath();
  if (claudePath) {
    add('claude-desktop', 'Claude Desktop', claudePath, () => getMcpJsonStatus(claudePath, keys));
  }

  try {
    const codexPath = getCodexConfigPath();
    add('codex', 'Codex', codexPath, () => getCodexStatus(keys));
  } catch (error) {
    console.error('[getStartedStatus] Could not resolve the Codex config path:', error);
  }

  try {
    const antigravityPath = getAntigravityConfigPath();
    add('antigravity', 'Antigravity', antigravityPath, () => {
      const current = getMcpJsonStatus(antigravityPath, keys);
      if (current.state === 'nexus-configured') return current;
      // Older builds kept the file elsewhere. When only that copy names Nexus,
      // let Open config open it; Connect still writes the current file.
      const legacyPath = getAntigravityLegacyConfigPath();
      const legacy = getMcpJsonStatus(legacyPath, keys);
      return legacy.state === 'nexus-configured' ? { status: legacy, statusPath: legacyPath } : current;
    });
  } catch (error) {
    console.error('[getStartedStatus] Could not resolve the Antigravity config path:', error);
  }

  return statuses;
}

export function isMCPConfigured(app: App): boolean {
  return getExternalClientStatuses(app).some(client => client.status.state === 'nexus-configured');
}

/** Installation is enough for onboarding. status() probes shells and runtimes, so it is avoided here. */
function isLocalCliInstalled(): boolean {
  if (!Platform.isDesktop || !supportsMCPBridge()) {
    return false;
  }
  try {
    const nodeFs = desktopRequire<typeof import('node:fs')>('node:fs');
    return nodeFs.existsSync(new LocalCliInstaller().getPaths().cliJsPath);
  } catch {
    return false;
  }
}

/** Claude Desktop, Codex and Antigravity configs that name this vault, plus the command line when installed. */
export function countExternalConnections(app: App): number {
  const clients = getExternalClientStatuses(app).filter(client => client.status.state === 'nexus-configured').length;
  return clients + (isLocalCliInstalled() ? 1 : 0);
}

export function hasExternalAgentSetup(app: App): boolean {
  if (!Platform.isDesktop || !supportsMCPBridge()) {
    return false;
  }
  return isLocalCliInstalled() || isMCPConfigured(app);
}
