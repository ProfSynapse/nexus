/**
 * Antigravity's Connect button. Failure this buys: a config that points at a
 * connector.js that was never written (the agent then fails silently), a
 * missing ~/.gemini/config folder making Connect throw, or a merge that drops
 * the user's other MCP servers.
 *
 * Real pieces: ExternalAgentsPage, getStartedStatus, mcpClientConfigs and the
 * real file system in a temporary home folder, seen through a desktopRequire
 * wrapper that records the order of writes. Faked: the Node.js lookup and the
 * local CLI installer.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Component, Platform } from 'obsidian';
import { createFakeRoot, FakeElement } from '../mocks/obsidian/dom';

const mockWrites: string[] = [];
jest.mock('../../src/utils/desktopRequire', () => ({
  desktopRequire: (name: string) => {
    const actual = jest.requireActual(name);
    if (name !== 'node:fs') return actual;
    return {
      ...actual,
      writeFileSync: (path: string, ...rest: unknown[]) => {
        mockWrites.push(path);
        return actual.writeFileSync(path, ...rest);
      }
    };
  }
}));
jest.mock('../../src/utils/platform', () => ({ supportsMCPBridge: () => true }));
jest.mock('../../src/utils/binaryDiscovery', () => ({ resolveDesktopBinaryPath: () => null }));
jest.mock('../../src/services/cli/LocalCliInstaller', () => ({
  LocalCliInstaller: jest.fn().mockImplementation(() => ({ isSupported: () => false, getPaths: () => ({ cliJsPath: '/nonexistent' }) }))
}));

import { ExternalAgentsPage } from '../../src/settings/getStarted/ExternalAgentsPage';
import { SettingsRouter } from '../../src/settings/SettingsRouter';
import { AGENTS_PAGE } from '../../src/settings/getStarted/copy';
import { getPrimaryServerKey } from '../../src/constants/branding';
import { CONNECTOR_JS_CONTENT } from '../../src/utils/connectorContent';
import { ANTIGRAVITY_CONFIG_SEGMENTS } from '../../src/utils/mcpClientConfigs';

let home: string;
const originalHome = process.env.HOME;
let NODE: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'nexus-antigravity-'));
  process.env.HOME = home;
  // A node binary that exists, so the written entry is not reported as stale.
  NODE = join(home, 'bin', 'node');
  mkdirSync(dirname(NODE), { recursive: true });
  writeFileSync(NODE, '');
  mockWrites.length = 0;
  Object.assign(Platform, { isDesktop: true, isMobile: false, isMacOS: true, isWin: false });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function configPath(): string {
  return join(home, ...ANTIGRAVITY_CONFIG_SEGMENTS);
}

function render() {
  const container = createFakeRoot();
  const pluginPath = join(home, 'Vault', '.obsidian', 'plugins', 'nexus');
  new ExternalAgentsPage(container as unknown as HTMLElement, {
    app: { vault: { getName: () => 'Vault' } } as never,
    router: new SettingsRouter(),
    component: new Component(),
    pluginPath
  }, () => ({ path: NODE, version: 'v24.11.0', manager: 'other' }));
  return { container, connector: join(pluginPath, 'connector.js') };
}

function antigravityRow(container: FakeElement): FakeElement {
  const row = container.querySelectorAll('.setting-item').find(item => item.querySelector('.setting-item-name')?.textContent === 'Antigravity');
  if (!row) throw new Error('No Antigravity row');
  return row;
}

function connect(container: FakeElement): void {
  const button = antigravityRow(container).querySelectorAll('button').find(el => el.textContent === AGENTS_PAGE.connect);
  if (!button) throw new Error('No Connect button');
  button.dispatch('click');
}

it('writes the connector first, then creates the config and its folder when missing', () => {
  const { container, connector } = render();
  expect(existsSync(dirname(configPath()))).toBe(false);

  connect(container);

  expect(mockWrites).toEqual([connector, configPath()]);
  expect(readFileSync(connector, 'utf-8')).toBe(CONNECTOR_JS_CONTENT);
  expect(JSON.parse(readFileSync(configPath(), 'utf-8'))).toEqual({
    mcpServers: { [getPrimaryServerKey('Vault')]: { command: NODE, args: [connector] } }
  });
  // The page re-renders with the new state.
  expect(antigravityRow(container).querySelector('.nexus-status')?.textContent).toBe(AGENTS_PAGE.connected);
});

it('merges into existing mcpServers and keeps every other server and setting', () => {
  mkdirSync(dirname(configPath()), { recursive: true });
  const other = { command: '/usr/bin/python3', args: ['server.py'], env: { TOKEN: 'x' } };
  writeFileSync(configPath(), JSON.stringify({ theme: 'dark', mcpServers: { other } }, null, 2));
  const { container, connector } = render();

  connect(container);

  const written = JSON.parse(readFileSync(configPath(), 'utf-8'));
  expect(written.theme).toBe('dark');
  expect(written.mcpServers.other).toEqual(other);
  expect(written.mcpServers[getPrimaryServerKey('Vault')]).toEqual({ command: NODE, args: [connector] });
});

it('keeps a copy of an unreadable config before replacing it', () => {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), '{ not json');
  const { container } = render();
  expect(antigravityRow(container).querySelector('.nexus-status')?.textContent).toBe(AGENTS_PAGE.invalidConfig);

  connect(container);

  expect(readFileSync(`${configPath()}.bak`, 'utf-8')).toBe('{ not json');
  expect(Object.keys(JSON.parse(readFileSync(configPath(), 'utf-8')).mcpServers)).toEqual([getPrimaryServerKey('Vault')]);
});
