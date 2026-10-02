import * as childProcess from 'child_process';
import * as nodeFs from 'fs';
import { Platform } from 'obsidian';
import { resolveDesktopBinaryPath } from '../../src/utils/binaryDiscovery';

jest.mock('child_process', () => ({
  execSync: jest.fn(),
  execFileSync: jest.fn()
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readdirSync: jest.fn()
}));

describe('resolveDesktopBinaryPath', () => {
  const originalAppData = process.env.APPDATA;
  const originalHome = process.env.HOME;
  const originalNvmDir = process.env.NVM_DIR;
  const execSyncMock = childProcess.execSync as jest.Mock;
  const execFileSyncMock = childProcess.execFileSync as jest.Mock;
  const existsSyncMock = nodeFs.existsSync as jest.Mock;
  const readdirSyncMock = nodeFs.readdirSync as jest.Mock;

  beforeEach(() => {
    Platform.isDesktop = true;
    Platform.isWin = true;
  });

  afterEach(() => {
    process.env.APPDATA = originalAppData;
    process.env.HOME = originalHome;
    if (originalNvmDir === undefined) {
      delete process.env.NVM_DIR;
    } else {
      process.env.NVM_DIR = originalNvmDir;
    }
    jest.resetAllMocks();
  });

  it('prefers Windows command wrappers when where returns an extensionless npm shim first', () => {
    execSyncMock.mockReturnValue(
      'C:\\Users\\test\\AppData\\Roaming\\npm\\claude\r\nC:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd\r\n' as never
    );
    existsSyncMock.mockImplementation((path) => {
      const candidate = String(path);
      return candidate.endsWith('\\claude') || candidate.endsWith('\\claude.cmd');
    });

    expect(resolveDesktopBinaryPath('claude')).toBe('C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd');
  });

  it('falls back to the first existing where result when no command wrapper exists', () => {
    execSyncMock.mockReturnValue(
      'C:\\Tools\\claude\r\nC:\\Tools\\claude.cmd\r\n' as never
    );
    existsSyncMock.mockImplementation((path) => String(path) === 'C:\\Tools\\claude');

    expect(resolveDesktopBinaryPath('claude')).toBe('C:\\Tools\\claude');
  });

  it('checks the npm global bin directory from APPDATA with wrapper-first ordering', () => {
    process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
    execSyncMock.mockImplementation(() => {
      throw new Error('not found');
    });
    existsSyncMock.mockImplementation((path) => (
      String(path).replace(/\//g, '\\') === 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd'
    ));

    expect(resolveDesktopBinaryPath('claude')?.replace(/\//g, '\\')).toBe(
      'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd'
    );
  });

  it('finds Node from the macOS login shell when the app PATH is stale', () => {
    Platform.isWin = false;
    const nodePath = '/Users/test/.nvm/versions/node/v24.4.0/bin/node';
    execSyncMock.mockImplementation(() => {
      throw new Error('node is not on the app PATH');
    });
    execFileSyncMock.mockReturnValue(`${nodePath}\n` as never);
    existsSyncMock.mockImplementation((path) => String(path) === nodePath);

    expect(resolveDesktopBinaryPath('node')).toBe(nodePath);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      process.env.SHELL || '/bin/zsh',
      ['-lc', "command -v 'node'"],
      expect.objectContaining({ encoding: 'utf8' })
    );
  });

  describe('per-user Unix install locations', () => {
    beforeEach(() => {
      Platform.isWin = false;
      process.env.HOME = '/home/test';
      delete process.env.NVM_DIR;
      execSyncMock.mockImplementation(() => {
        throw new Error('node is not on the app PATH');
      });
    });

    it('finds the newest nvm-installed Node without spawning a shell', () => {
      const nodePath = '/home/test/.nvm/versions/node/v24.4.0/bin/node';
      readdirSyncMock.mockReturnValue(['v9.11.2', 'v24.4.0', 'v18.20.4', 'system'] as never);
      existsSyncMock.mockImplementation((path) => String(path) === nodePath);

      expect(resolveDesktopBinaryPath('node')).toBe(nodePath);
      expect(readdirSyncMock).toHaveBeenCalledWith('/home/test/.nvm/versions/node');
      expect(execFileSyncMock).not.toHaveBeenCalled();
    });

    it('honors NVM_DIR when looking for nvm versions', () => {
      process.env.NVM_DIR = '/opt/nvm';
      const nodePath = '/opt/nvm/versions/node/v22.1.0/bin/node';
      readdirSyncMock.mockReturnValue(['v22.1.0'] as never);
      existsSyncMock.mockImplementation((path) => String(path) === nodePath);

      expect(resolveDesktopBinaryPath('node')).toBe(nodePath);
    });

    it('finds Node installed by Volta', () => {
      const nodePath = '/home/test/.volta/bin/node';
      readdirSyncMock.mockImplementation(() => {
        throw new Error('no nvm');
      });
      existsSyncMock.mockImplementation((path) => String(path) === nodePath);

      expect(resolveDesktopBinaryPath('node')).toBe(nodePath);
    });

    it('prefers system install locations over per-user ones', () => {
      readdirSyncMock.mockReturnValue(['v24.4.0'] as never);
      existsSyncMock.mockImplementation((path) => (
        String(path) === '/usr/local/bin/node'
        || String(path) === '/home/test/.nvm/versions/node/v24.4.0/bin/node'
      ));

      expect(resolveDesktopBinaryPath('node')).toBe('/usr/local/bin/node');
    });

    it('retries with an interactive login shell and ignores shell noise', () => {
      const nodePath = '/home/test/custom/bin/node';
      readdirSyncMock.mockImplementation(() => {
        throw new Error('no nvm');
      });
      execFileSyncMock
        .mockReturnValueOnce('' as never)
        .mockReturnValueOnce(`bash: no job control in this shell\n${nodePath}\n` as never);
      existsSyncMock.mockImplementation((path) => String(path) === nodePath);

      expect(resolveDesktopBinaryPath('node')).toBe(nodePath);
      expect(execFileSyncMock).toHaveBeenNthCalledWith(
        2,
        process.env.SHELL || '/bin/zsh',
        ['-ilc', "command -v 'node'"],
        expect.objectContaining({ encoding: 'utf8' })
      );
    });
  });
});
