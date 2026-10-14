/**
 * The copied config and prompt carry this computer's real paths. Failure this
 * buys: Windows backslashes pasted unescaped into JSON (`"C:\Users\..."` is
 * invalid JSON or silently turns `\n`/`\t` into control characters), an agent
 * that rewrites the connector path, or a home folder taken from $HOME on
 * Windows where Antigravity reads %USERPROFILE%.
 */
import { win32 } from 'node:path';
import { Platform } from 'obsidian';

jest.mock('../../src/utils/desktopRequire', () => ({
  desktopRequire: (name: string) => (name === 'node:path' ? jest.requireActual('node:path').win32 : jest.requireActual(name))
}));

import { buildMcpConfigJson, buildMcpServerEntry, getAntigravityConfigPath } from '../../src/utils/mcpClientConfigs';
import { buildAgentSetupPrompt } from '../../src/settings/getStarted/copy';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const CONNECTOR = 'C:\\Users\\you\\Documents\\Vault\\.obsidian\\plugins\\nexus\\connector.js';
const originalEnv = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };

afterEach(() => {
  Object.assign(Platform, { isWin: false, isMacOS: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it('escapes Windows backslashes in the copied config and round-trips the exact paths', () => {
  const json = buildMcpConfigJson('nexus-vault', NODE, CONNECTOR);
  expect(json).toContain('C:\\\\Program Files\\\\nodejs\\\\node.exe');
  expect(JSON.parse(json)).toEqual({ mcpServers: { 'nexus-vault': { command: NODE, args: [CONNECTOR] } } });
});

it('JSON-escapes the connector path inside the prompt\'s args array', () => {
  const prompt = buildAgentSetupPrompt('nexus-vault', NODE, CONNECTOR);
  const args = /Args: (\[.*?\])\. Use these paths exactly\./.exec(prompt);
  expect(args).not.toBeNull();
  expect(JSON.parse(args![1])).toEqual([CONNECTOR]);
  expect(prompt).toContain(`Name: nexus-vault. Command: ${NODE}.`);
});

it('refuses to build an entry without a node path', () => {
  expect(() => buildMcpServerEntry('', CONNECTOR)).toThrow();
  expect(() => buildMcpConfigJson('nexus-vault', ' ', CONNECTOR)).toThrow();
});

it('puts the Antigravity config under %USERPROFILE% on Windows', () => {
  Object.assign(Platform, { isWin: true, isMacOS: false });
  process.env.USERPROFILE = 'C:\\Users\\you';
  process.env.HOME = '/should/not/be/used';
  expect(getAntigravityConfigPath()).toBe(win32.join('C:\\Users\\you', '.gemini', 'config', 'mcp_config.json'));
});
