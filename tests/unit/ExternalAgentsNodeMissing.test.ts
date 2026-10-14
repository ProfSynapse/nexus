/**
 * Connect an external agent: Node.js comes first. Failure this buys: with no
 * Node.js, a Connect/Create/Copy that still works and writes or copies a config
 * whose command is a bare `node` (which fails in apps opened from the Dock,
 * because they do not see the terminal's PATH); with Node.js, a config that
 * does not name the exact binary Nexus found.
 *
 * Real pieces: ExternalAgentsPage, getStartedStatus, mcpClientConfigs and the
 * real file system in a temporary home folder. Faked: the Node.js lookup
 * (injected), the local CLI installer (it probes shells) and the Setting mocks
 * rendering a FakeElement tree.
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Component, Platform } from 'obsidian';
import { createFakeRoot, FakeElement } from '../mocks/obsidian/dom';
import type { NodeRuntime } from '../../src/utils/nodeRuntime';

jest.mock('../../src/utils/desktopRequire', () => ({
  desktopRequire: (name: string) => jest.requireActual(name)
}));
jest.mock('../../src/utils/platform', () => ({ supportsMCPBridge: () => true }));
jest.mock('../../src/utils/binaryDiscovery', () => ({ resolveDesktopBinaryPath: () => null }));
jest.mock('../../src/services/cli/LocalCliInstaller', () => ({
  LocalCliInstaller: jest.fn().mockImplementation(() => ({
    isSupported: () => true,
    reconcile: () => false,
    getPaths: () => ({ cliJsPath: '/nonexistent/nexus-cli.js' }),
    status: () => ({
      installed: false, onPath: false, pathConfigured: false, runtimeReady: false, stale: false,
      skillLinked: false, cursorLinked: false, codexLinked: false,
      detected: { claudeCode: true, cursor: false, codex: true },
      paths: { cliJsPath: '/nonexistent/nexus-cli.js' }, pathFix: null
    })
  }))
}));

import { ExternalAgentsPage } from '../../src/settings/getStarted/ExternalAgentsPage';
import { SettingsRouter } from '../../src/settings/SettingsRouter';
import { AGENTS_PAGE } from '../../src/settings/getStarted/copy';
import { getServerKeyCandidates } from '../../src/constants/branding';

let home: string;
const originalEnv = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'nexus-agents-page-'));
  process.env.HOME = home;
  delete process.env.CODEX_HOME;
  Object.assign(Platform, { isDesktop: true, isMobile: false, isMacOS: true, isWin: false });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function render(findNode: () => NodeRuntime | null) {
  const container = createFakeRoot();
  const pluginPath = join(home, 'Vault', '.obsidian', 'plugins', 'nexus');
  const page = new ExternalAgentsPage(container as unknown as HTMLElement, {
    app: { vault: { getName: () => 'Vault' } } as never,
    router: new SettingsRouter(),
    component: new Component(),
    pluginPath
  }, findNode);
  return { container, page, pluginPath };
}

function rowByName(container: FakeElement, name: string): FakeElement {
  const row = container.querySelectorAll('.setting-item').find(item => {
    const nameEl = item.querySelector('.setting-item-name')!;
    const badge = nameEl.querySelector('.nexus-step')?.textContent ?? '';
    return nameEl.textContent.slice(badge.length) === name;
  });
  if (!row) throw new Error(`No row ${name}`);
  return row;
}

function buttons(row: FakeElement): FakeElement[] {
  return row.querySelectorAll('button');
}

function openOtherAgents(container: FakeElement): void {
  rowByName(container, AGENTS_PAGE.otherName).dispatch('click');
}

const APPS = ['Claude Desktop', 'Codex', 'Antigravity'];
const node: NodeRuntime = { path: '/opt/homebrew/bin/node', version: 'v24.11.0', manager: 'other' };

it('puts Node.js first and, when it is missing, offers Install and Check again', () => {
  const { container } = render(() => null);
  const rows = container.querySelectorAll('.setting-item');
  const first = rows[0];
  expect(first.querySelector('.setting-item-name')?.textContent).toBe(AGENTS_PAGE.nodeName);
  expect(first.hasClass('nexus-node-missing')).toBe(true);
  expect(first.querySelector('.setting-item-description')?.textContent).toBe(AGENTS_PAGE.nodeMissing);
  expect(buttons(first).map(el => el.textContent)).toEqual([AGENTS_PAGE.installNode, AGENTS_PAGE.checkAgain]);
  expect(buttons(first)[0].hasClass('mod-cta')).toBe(true);
});

it('blocks every Connect, Create and Copy while Node.js is missing', () => {
  const { container } = render(() => null);
  for (const app of APPS) {
    const row = rowByName(container, app);
    expect(row.querySelector('.nexus-status')?.textContent).toBe(AGENTS_PAGE.needsNode);
    for (const button of buttons(row)) expect(button.disabled).toBe(true);
  }

  openOtherAgents(container);
  for (const step of [AGENTS_PAGE.step1Name, AGENTS_PAGE.step2Name, AGENTS_PAGE.step3Name]) {
    const row = rowByName(container, step);
    expect(buttons(row).length).toBeGreaterThan(0);
    for (const button of buttons(row)) expect(button.disabled).toBe(true);
  }
  const previews = container.querySelectorAll('pre.nexus-code').map(el => el.textContent);
  expect(previews).toEqual([AGENTS_PAGE.step2NeedsNode, AGENTS_PAGE.step3NeedsNode]);
});

it('never shows a bare node command, with or without Node.js', () => {
  let found: NodeRuntime | null = null;
  const { container } = render(() => found);
  openOtherAgents(container);
  const bare = (text: string) => /"command":\s*"node"/.test(text) || /Command: node\./.test(text);
  expect(container.querySelectorAll('pre').some(el => bare(el.textContent))).toBe(false);

  found = node;
  rowByName(container, AGENTS_PAGE.nodeName).querySelectorAll('button')[1].dispatch('click');
  const previews = container.querySelectorAll('pre.nexus-code').map(el => el.textContent);
  expect(previews).toHaveLength(2);
  expect(previews.some(bare)).toBe(false);
  expect(previews[1]).toContain(`Command: ${node.path}.`);
});

it('Check again finds Node.js and unblocks the page', () => {
  let found: NodeRuntime | null = null;
  const { container, pluginPath } = render(() => found);
  found = node;
  rowByName(container, AGENTS_PAGE.nodeName).querySelectorAll('button')[1].dispatch('click');

  const nodeRow = rowByName(container, AGENTS_PAGE.nodeName);
  expect(nodeRow.querySelector('.setting-item-description')?.textContent).toBe(AGENTS_PAGE.nodeFound(node.version, node.path));
  expect(nodeRow.querySelector('.setting-item-description code')?.textContent).toBe(node.path);
  expect(nodeRow.querySelector('.nexus-status')?.textContent).toBe(AGENTS_PAGE.nodeFoundStatus);
  // Claude Desktop is not installed in this home folder; it has its own test below.
  for (const app of APPS.filter(name => name !== 'Claude Desktop')) {
    const row = rowByName(container, app);
    expect(row.querySelector('.nexus-status')?.textContent).toBe(AGENTS_PAGE.ready);
    const connect = buttons(row).find(el => el.textContent === AGENTS_PAGE.connect)!;
    expect(connect.disabled).toBe(false);
  }

  openOtherAgents(container);
  const config = JSON.parse(container.querySelectorAll('pre.nexus-code')[0].textContent);
  const key = getServerKeyCandidates('Vault')[0];
  expect(config).toEqual({ mcpServers: { [key]: { command: node.path, args: [join(pluginPath, 'connector.js')] } } });
});

it('shows Claude Desktop as Not found, with no Connect, when its folder is missing', () => {
  const claudeDir = join(home, 'Library', 'Application Support', 'Claude');
  const { container } = render(() => node);
  let row = rowByName(container, 'Claude Desktop');
  expect(row.querySelector('.nexus-status')?.textContent).toBe(AGENTS_PAGE.notFound);
  expect(buttons(row).map(el => el.textContent)).toEqual([AGENTS_PAGE.download, AGENTS_PAGE.checkAgain]);
  expect(existsSync(claudeDir)).toBe(false);

  // Installing the app creates the folder; Check again then offers Connect.
  mkdirSync(claudeDir, { recursive: true });
  buttons(row)[1].dispatch('click');
  row = rowByName(container, 'Claude Desktop');
  expect(row.querySelector('.nexus-status')?.textContent).toBe(AGENTS_PAGE.ready);
  expect(buttons(row).map(el => el.textContent)).toEqual([AGENTS_PAGE.connect]);
});

it('warns that an nvm path moves when the Node version changes', () => {
  const { container } = render(() => ({ ...node, path: '/Users/you/.nvm/versions/node/v24.11.0/bin/node', manager: 'nvm' }));
  expect(container.querySelector('.nexus-node-warning')?.textContent).toBe(AGENTS_PAGE.nodeNvmWarning);
});

it('shows a connected app as Connected with Open config, and a moved node path as Reconnect', () => {
  const key = getServerKeyCandidates('Vault')[0];
  const configPath = join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  const connector = join(home, 'connector.js');
  writeFileSync(connector, '');
  const write = (command: string) => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ mcpServers: { [key]: { command, args: [connector] } } }));
  };

  const realNode = join(home, 'node');
  writeFileSync(realNode, '');
  write(realNode);
  let { container } = render(() => node);
  let row = rowByName(container, 'Claude Desktop');
  expect(row.querySelector('.nexus-status')?.textContent).toBe(AGENTS_PAGE.connected);
  expect(buttons(row).map(el => el.textContent)).toEqual([AGENTS_PAGE.openConfig]);

  write(join(home, '.nvm/versions/node/v20.0.0/bin/node'));
  ({ container } = render(() => node));
  row = rowByName(container, 'Claude Desktop');
  expect(row.querySelector('.nexus-status')?.textContent).toBe(AGENTS_PAGE.reconnect);
  expect(buttons(row).map(el => el.textContent)).toEqual([AGENTS_PAGE.connect]);
});

it('links the MCP setup guide to the real page, not "#"', () => {
  const { container } = render(() => node);
  openOtherAgents(container);
  const link = container.querySelector('.nexus-other-steps a')!;
  expect(link.getAttribute('href')).toBe('https://github.com/ProfSynapse/nexus/blob/main/guide/mcp-setup.md');
  expect(container.querySelectorAll('a').some(el => el.getAttribute('href') === '#')).toBe(false);
});

it('expands and collapses the Other agents steps in place, with the row as the only control', () => {
  const { container } = render(() => node);
  const row = rowByName(container, AGENTS_PAGE.otherName);
  const steps = container.querySelector('.nexus-other-steps')!;
  expect(steps.isShown()).toBe(false);
  expect(row.getAttribute('aria-expanded')).toBe('false');
  expect(row.getAttribute('role')).toBe('button');
  expect(row.getAttribute('aria-controls')).toBe(steps.getAttribute('id'));
  // No focusable control nested inside the role=button row.
  expect(row.querySelectorAll('button, .extra-setting-button, [tabindex]')).toHaveLength(0);
  expect(row.querySelector('.setting-item-chevron')?.getAttribute('aria-hidden')).toBe('true');

  row.dispatch('keydown', { key: ' ' });
  // Toggled in place: the same row element, so keyboard focus is not lost.
  expect(rowByName(container, AGENTS_PAGE.otherName)).toBe(row);
  expect(row.getAttribute('aria-expanded')).toBe('true');
  expect(steps.isShown()).toBe(true);
  const numbers = steps.children
    .filter(item => item.hasClass('setting-item'))
    .map(item => item.querySelector('.nexus-step')?.textContent);
  expect(numbers).toEqual(['1', '2', '3', '4']);

  row.dispatch('click');
  expect(row.getAttribute('aria-expanded')).toBe('false');
  expect(steps.isShown()).toBe(false);
});
