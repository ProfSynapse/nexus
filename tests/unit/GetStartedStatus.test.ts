/** Regression: a fully configured single setup path must not reopen onboarding. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { App, Platform } from 'obsidian';
import type { LLMProviderConfig } from '../../src/types/llm/ProviderTypes';
import { getServerKeyCandidates } from '../../src/constants/branding';
import { buildCodexMcpTomlSnippet } from '../../src/utils/codexMcpConfig';
import { LocalCliInstaller } from '../../src/services/cli/LocalCliInstaller';
import { getClaudeDesktopConfigPath, hasExternalAgentSetup, isProviderConfigured, shouldOpenGetStarted } from '../../src/settings/getStartedStatus';

let mockHome: string;
jest.mock('../../src/utils/desktopRequire', () => ({
  desktopRequire: (name: string) => name === 'node:os'
    ? { homedir: () => mockHome }
    : jest.requireActual(name)
}));
jest.mock('../../src/utils/platform', () => ({ supportsMCPBridge: () => Platform.isDesktop }));

const app = { vault: { getName: () => 'Setup test' } } as unknown as App;
const config = (extra: Partial<LLMProviderConfig> = {}): LLMProviderConfig => ({ enabled: true, apiKey: '', ...extra });
const connected = { connected: true, providerId: 'test', connectedAt: 1 };
const settings = { enabledVault: true };
const originalEnv = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  mockHome = mkdtempSync(join(tmpdir(), 'nexus-setup-test-'));
  process.env.HOME = mockHome;
  process.env.CODEX_HOME = join(mockHome, 'custom-codex');
  Object.assign(Platform, { isDesktop: true, isMacOS: true, isWin: false });
});
afterEach(() => {
  rmSync(mockHome, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it('opens for a fresh install, but either chat or external setup suffices', () => {
  expect(shouldOpenGetStarted(app, settings)).toBe(true);
  expect(shouldOpenGetStarted(app, {
    ...settings,
    llmProviders: { defaultModel: { provider: 'openai', model: 'test' }, providers: { openai: config({ apiKey: 'test-key' }) } }
  })).toBe(false);
  write(new LocalCliInstaller().getPaths().cliJsPath, '// installed CLI');
  expect(shouldOpenGetStarted(app, settings)).toBe(false);
});

it('honors explicit closed and open preferences regardless of setup', () => {
  expect(shouldOpenGetStarted(app, { ...settings, getStartedOpen: false })).toBe(false);
  write(new LocalCliInstaller().getPaths().cliJsPath, '// installed CLI');
  expect(shouldOpenGetStarted(app, { ...settings, getStartedOpen: true })).toBe(true);
});

it.each(getServerKeyCandidates('Setup test'))('recognizes Claude MCP configuration for %s', (key) => {
  write(getClaudeDesktopConfigPath()!, JSON.stringify({ mcpServers: { [key]: { command: 'node', args: ['connector.js'] } } }));
  expect(shouldOpenGetStarted(app, settings)).toBe(false);
});

it.each(getServerKeyCandidates('Setup test'))('recognizes Codex-only configuration for %s in CODEX_HOME', (key) => {
  write(join(process.env.CODEX_HOME!, 'config.toml'), buildCodexMcpTomlSnippet(key, 'node', ['connector.js']));
  expect(shouldOpenGetStarted(app, settings)).toBe(false);
});

it('uses the default Codex home when no override exists', () => {
  delete process.env.CODEX_HOME;
  write(join(mockHome, '.codex/config.toml'), buildCodexMcpTomlSnippet(getServerKeyCandidates('Setup test')[0], 'node', []));
  expect(hasExternalAgentSetup(app)).toBe(true);
});

it('does not count a different vault, and tolerates unreadable Codex configuration', () => {
  write(join(process.env.CODEX_HOME!, 'config.toml'), buildCodexMcpTomlSnippet('nexus-other', 'node', []));
  expect(hasExternalAgentSetup(app)).toBe(false);
  rmSync(join(process.env.CODEX_HOME!, 'config.toml'));
  mkdirSync(join(process.env.CODEX_HOME!, 'config.toml'));
  expect(hasExternalAgentSetup(app)).toBe(false);
});

it('does not inspect desktop setup on mobile', () => {
  Platform.isDesktop = false;
  expect(hasExternalAgentSetup(app)).toBe(false);
});

it.each(['anthropic-claude-code', 'google-gemini-cli'])('recognizes connected %s without an API key', (id) => {
  expect(isProviderConfigured(id, config({ oauth: connected }))).toBe(true);
  expect(isProviderConfigured(id, config())).toBe(false);
});

it.each(['openai-codex', 'github-copilot'])('requires OAuth connection and token for %s', (id) => {
  expect(isProviderConfigured(id, config({ apiKey: 'token', oauth: connected }))).toBe(true);
  expect(isProviderConfigured(id, config({ oauth: connected }))).toBe(false);
  expect(isProviderConfigured(id, config({ apiKey: 'token' }))).toBe(false);
});

it('recognizes a keyless endpoint and rejects disabled or blank configurations', () => {
  const endpoint = config({ driverKind: 'openai-compatible', openaiCompatible: { schemaVersion: 1, displayName: 'Local', baseUrl: 'http://localhost:1234/v1', models: {} } });
  expect(isProviderConfigured('local-endpoint', endpoint)).toBe(true);
  expect(isProviderConfigured('local-endpoint', { ...endpoint, enabled: false })).toBe(false);
  expect(isProviderConfigured('local-endpoint', { ...endpoint, openaiCompatible: undefined })).toBe(false);
  expect(isProviderConfigured('openai', config({ apiKey: ' ' }))).toBe(false);
  expect(isProviderConfigured('webllm', config())).toBe(true);
  for (const id of ['ollama', 'lmstudio']) {
    expect(isProviderConfigured(id, config({ apiKey: 'http://localhost:1234' }))).toBe(true);
    expect(isProviderConfigured(id, config())).toBe(false);
  }
});
