/**
 * resolveNodeRuntime reports the Node.js binary, its version and whether nvm
 * manages it. Failure this buys: the nvm warning missing for an nvm path (the
 * saved config then breaks silently after `nvm use`), a version string with a
 * trailing newline in the UI, or a crash when `--version` cannot run.
 */
import { Platform } from 'obsidian';

const mockExecFileSync = jest.fn();
jest.mock('../../src/utils/desktopRequire', () => ({
  desktopRequire: (name: string) => (name === 'node:child_process' ? { execFileSync: mockExecFileSync } : jest.requireActual(name))
}));
const mockResolve = jest.fn();
jest.mock('../../src/utils/binaryDiscovery', () => ({ resolveDesktopBinaryPath: (name: string) => mockResolve(name) }));

import { detectNodeManager, parseNodeVersion, resolveNodeRuntime } from '../../src/utils/nodeRuntime';

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(Platform, { isDesktop: true, isMobile: false });
});

it('detects an nvm-managed node and reads its version', () => {
  const path = '/Users/you/.nvm/versions/node/v24.11.0/bin/node';
  mockResolve.mockReturnValue(path);
  mockExecFileSync.mockReturnValue('v24.11.0\n');

  expect(resolveNodeRuntime()).toEqual({ path, version: 'v24.11.0', manager: 'nvm' });
  expect(mockResolve).toHaveBeenCalledWith('node');
  expect(mockExecFileSync).toHaveBeenCalledWith(path, ['--version'], expect.objectContaining({ timeout: 3000 }));
});

it('treats system and Homebrew installs as stable, and recognises nvm-windows', () => {
  expect(detectNodeManager('/opt/homebrew/bin/node')).toBe('other');
  expect(detectNodeManager('C:\\Program Files\\nodejs\\node.exe')).toBe('other');
  expect(detectNodeManager('C:\\Users\\you\\AppData\\Roaming\\nvm\\v24.11.0\\node.exe')).toBe('nvm');
});

it('parses `node --version` output and rejects anything else', () => {
  expect(parseNodeVersion('v24.11.0\n')).toBe('v24.11.0');
  expect(parseNodeVersion('  v18.20.4  ')).toBe('v18.20.4');
  expect(parseNodeVersion('command not found')).toBe('');
});

it('keeps the path when the version cannot be read', () => {
  mockResolve.mockReturnValue('/usr/bin/node');
  mockExecFileSync.mockImplementation(() => { throw new Error('timeout'); });
  expect(resolveNodeRuntime()).toEqual({ path: '/usr/bin/node', version: '', manager: 'other' });
});

it('returns null when node cannot be found', () => {
  mockResolve.mockReturnValue(null);
  expect(resolveNodeRuntime()).toBeNull();
  expect(mockExecFileSync).not.toHaveBeenCalled();
});
