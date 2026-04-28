import * as childProcess from 'child_process';
import * as nodeFs from 'fs';
import { Platform } from 'obsidian';
import { resolveDesktopBinaryPath } from '../../src/utils/binaryDiscovery';

jest.mock('child_process', () => ({
  execSync: jest.fn(),
  execFileSync: jest.fn()
}));

jest.mock('fs', () => ({
  existsSync: jest.fn()
}));

describe('resolveDesktopBinaryPath', () => {
  const originalAppData = process.env.APPDATA;
  const execSyncMock = childProcess.execSync as jest.Mock;
  const existsSyncMock = nodeFs.existsSync as jest.Mock;

  beforeEach(() => {
    Platform.isDesktop = true;
    Platform.isWin = true;
  });

  afterEach(() => {
    process.env.APPDATA = originalAppData;
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
});
