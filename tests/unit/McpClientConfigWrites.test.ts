/**
 * Connect / Reconnect writes to the user's own MCP client configs.
 *
 * Failures this buys: Reconnect (after an nvm switch) rewriting the whole
 * Nexus entry and silently dropping the user's env and timeout settings; an
 * entry left under the legacy key getting a second, primary-key server beside
 * it so the client keeps launching the broken one; a config saved with a UTF-8
 * byte order mark being treated as unreadable and replaced; and a second
 * unreadable config overwriting the first one's backup.
 *
 * Real pieces: mcpClientConfigs and codexMcpConfig against the real file
 * system in a temporary home folder.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Platform } from 'obsidian';

jest.mock('../../src/utils/desktopRequire', () => ({
  desktopRequire: (name: string) => jest.requireActual(name)
}));

import { getMcpJsonStatus, writeCodexServer, writeMcpJsonServer } from '../../src/utils/mcpClientConfigs';
import { buildCodexMcpTomlSnippet, readCodexMcpServerConfig } from '../../src/utils/codexMcpConfig';

const KEYS = ['nexus-vault', 'claudesidian-mcp-vault'];
const ENTRY = { command: '/new/node', args: ['/vault/connector.js'] };
let home: string;
const originalEnv = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'nexus-mcp-writes-'));
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

function jsonConfig(content: string): string {
  const path = join(home, 'Claude', 'claude_desktop_config.json');
  mkdirSync(join(home, 'Claude'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe('JSON mcpServers configs', () => {
  it('Reconnect changes command and args only, keeping env and other fields', () => {
    const path = jsonConfig(JSON.stringify({
      mcpServers: { 'nexus-vault': { command: '/old/node', args: ['/old.js'], env: { NODE_OPTIONS: '--x' }, timeout: 60 } }
    }));
    writeMcpJsonServer(path, KEYS, ENTRY);
    expect(JSON.parse(readFileSync(path, 'utf-8')).mcpServers).toEqual({
      'nexus-vault': { command: '/new/node', args: ['/vault/connector.js'], env: { NODE_OPTIONS: '--x' }, timeout: 60 }
    });
  });

  it('repairs an entry under the legacy key instead of adding a second server', () => {
    const path = jsonConfig(JSON.stringify({ mcpServers: { 'claudesidian-mcp-vault': { command: '/old/node', args: ['/old.js'] } } }));
    writeMcpJsonServer(path, KEYS, ENTRY);
    expect(JSON.parse(readFileSync(path, 'utf-8')).mcpServers).toEqual({ 'claudesidian-mcp-vault': ENTRY });
  });

  it('reads and updates a config saved with a byte order mark instead of replacing it', () => {
    const path = jsonConfig('﻿' + JSON.stringify({ mcpServers: { other: { command: 'python', args: [] } } }));
    expect(getMcpJsonStatus(path, KEYS).state).toBe('config-exists');
    const result = writeMcpJsonServer(path, KEYS, ENTRY);
    expect(result.replacedInvalid).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf-8')).mcpServers)).toEqual(['other', 'nexus-vault']);
  });

  it('never overwrites an earlier backup of an unreadable config', () => {
    const path = jsonConfig('{ "first": true, }');
    writeFileSync(`${path}.bak`, 'an older backup');
    const result = writeMcpJsonServer(path, KEYS, ENTRY);
    expect(result.replacedInvalid).toBe(true);
    expect(result.backupPath).toBe(`${path}.1.bak`);
    expect(readFileSync(`${path}.bak`, 'utf-8')).toBe('an older backup');
    expect(readFileSync(`${path}.1.bak`, 'utf-8')).toBe('{ "first": true, }');
  });
});

describe('Codex config.toml', () => {
  const codexPath = () => join(home, '.codex', 'config.toml');

  it('Reconnect keeps env and timeouts in the Nexus table', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    const content = `${buildCodexMcpTomlSnippet('nexus-vault', '/old/node', ['/old.js'])}\nenv = { NODE_OPTIONS = "--x" }\nstartup_timeout_sec = 60\n`;
    writeFileSync(codexPath(), content);
    writeCodexServer(KEYS, ENTRY);
    const written = readFileSync(codexPath(), 'utf-8');
    expect(written).toContain('env = { NODE_OPTIONS = "--x" }');
    expect(written).toContain('startup_timeout_sec = 60');
    expect(readCodexMcpServerConfig(written, 'nexus-vault')).toEqual(ENTRY);
  });

  it('repairs a table under the legacy key instead of adding a second one', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(codexPath(), buildCodexMcpTomlSnippet('claudesidian-mcp-vault', '/old/node', ['/old.js']) + '\n');
    writeCodexServer(KEYS, ENTRY);
    const written = readFileSync(codexPath(), 'utf-8');
    expect(readCodexMcpServerConfig(written, 'claudesidian-mcp-vault')).toEqual(ENTRY);
    expect(readCodexMcpServerConfig(written, 'nexus-vault')).toBeNull();
  });

  it('adds the current key when no table exists', () => {
    writeCodexServer(KEYS, ENTRY);
    expect(readCodexMcpServerConfig(readFileSync(codexPath(), 'utf-8'), 'nexus-vault')).toEqual(ENTRY);
  });
});
