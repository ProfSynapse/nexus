/**
 * LocalCliInstaller — real-filesystem test against a temp HOME.
 *
 * Mocks obsidian's Platform (desktop) and desktopRequire (so it returns real
 * node modules, with os.homedir redirected to the temp dir), then exercises the
 * enable → status → reconcile → uninstall lifecycle and asserts on-disk effects.
 */
import * as realFs from 'fs';
import * as realOs from 'os';
import * as realPath from 'path';

let TEST_HOME = '';
const ORIGINAL_LOCALAPPDATA = process.env.LOCALAPPDATA;
const ORIGINAL_PATH = process.env.PATH;
const mockSpawnSync = jest.fn();

jest.mock('obsidian', () => ({
    Platform: { isDesktop: true, isWin: false, isMacOS: true, isMobile: false },
}));

jest.mock('../../../src/utils/desktopRequire', () => ({
    desktopRequire: (moduleName: string) => {
        const name = moduleName.replace(/^node:/, '');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(name);
        if (name === 'os') {
            return { ...mod, homedir: () => TEST_HOME };
        }
        if (name === 'child_process') {
            return { ...mod, spawnSync: mockSpawnSync };
        }
        return mod;
    },
}));

import { LocalCliInstaller } from '../../../src/services/cli/LocalCliInstaller';
import { NEXUS_CLI_JS } from '../../../src/utils/cliAssets';

describe('LocalCliInstaller', () => {
    let installer: LocalCliInstaller;
    const posixIt = process.platform === 'win32' ? it.skip : it;

    beforeEach(() => {
        const platform = jest.requireMock('obsidian').Platform as {
            isDesktop: boolean;
            isWin: boolean;
            isMacOS: boolean;
            isMobile: boolean;
        };
        platform.isWin = false;
        platform.isMacOS = true;
        if (ORIGINAL_LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA;
        else process.env.LOCALAPPDATA = ORIGINAL_LOCALAPPDATA;
        if (ORIGINAL_PATH === undefined) delete process.env.PATH;
        else process.env.PATH = ORIGINAL_PATH;
        mockSpawnSync.mockReset();
        TEST_HOME = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'nexus-cli-test-'));
        // Simulate all three agents being installed so detection fires.
        realFs.mkdirSync(realPath.join(TEST_HOME, '.claude'), { recursive: true });
        realFs.mkdirSync(realPath.join(TEST_HOME, '.cursor'), { recursive: true });
        realFs.mkdirSync(realPath.join(TEST_HOME, '.codex'), { recursive: true });
        installer = new LocalCliInstaller();
    });

    afterEach(() => {
        realFs.rmSync(TEST_HOME, { recursive: true, force: true });
        if (ORIGINAL_LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA;
        else process.env.LOCALAPPDATA = ORIGINAL_LOCALAPPDATA;
        if (ORIGINAL_PATH === undefined) delete process.env.PATH;
        else process.env.PATH = ORIGINAL_PATH;
    });

    posixIt('enable() writes the CLI, skill, PATH symlink, Claude + Cursor skill links, and Codex block', () => {
        const result = installer.enable();
        const p = installer.getPaths();

        expect(realFs.readFileSync(p.cliJsPath, 'utf-8')).toBe(NEXUS_CLI_JS);
        expect(realFs.readFileSync(p.skillMdPath, 'utf-8')).toContain('# Nexus vault CLI');
        expect(realFs.lstatSync(p.binPath).isSymbolicLink()).toBe(true);
        expect(realFs.realpathSync(p.binPath)).toBe(realFs.realpathSync(p.cliJsPath));
        expect(realFs.lstatSync(p.claudeSkillLink).isSymbolicLink()).toBe(true);
        expect(realFs.lstatSync(p.cursorSkillLink).isSymbolicLink()).toBe(true);
        expect(realFs.realpathSync(p.cursorSkillLink)).toBe(realFs.realpathSync(p.skillDir));
        expect(realFs.readFileSync(p.codexAgentsPath, 'utf-8')).toContain('Nexus vault access');
        expect(result.created).toContain(p.cliJsPath);
        expect(result.detected).toEqual({ claudeCode: true, cursor: true, codex: true });
    });

    posixIt('status() reflects an installed, on-PATH, linked state', () => {
        installer.enable();
        const s = installer.status();
        expect(s.installed).toBe(true);
        expect(s.onPath).toBe(true);
        expect(s.stale).toBe(false);
        expect(s.skillLinked).toBe(true);
        expect(s.cursorLinked).toBe(true);
        expect(s.codexLinked).toBe(true);
    });

    posixIt('enable(targets) wires only the selected providers', () => {
        installer.enable({ claudeCode: true, cursor: false, codex: false });
        const s = installer.status();
        expect(s.installed).toBe(true);
        expect(s.skillLinked).toBe(true);
        expect(s.cursorLinked).toBe(false);
        expect(s.codexLinked).toBe(false);
    });

    posixIt('setProvider() wires and unwires a single provider without touching the others', () => {
        installer.enable({ claudeCode: true, cursor: false, codex: false });
        expect(installer.status().cursorLinked).toBe(false);

        installer.setProvider('cursor', true);
        let s = installer.status();
        expect(s.cursorLinked).toBe(true);
        expect(s.skillLinked).toBe(true);

        installer.setProvider('cursor', false);
        s = installer.status();
        expect(s.cursorLinked).toBe(false);
        expect(s.skillLinked).toBe(true);
    });

    posixIt('reconcile() refreshes a stale on-disk CLI copy', () => {
        installer.enable();
        const p = installer.getPaths();
        realFs.writeFileSync(p.cliJsPath, '// stale content', 'utf-8');
        expect(installer.status().stale).toBe(true);

        const changed = installer.reconcile();
        expect(changed).toBe(true);
        expect(realFs.readFileSync(p.cliJsPath, 'utf-8')).toBe(NEXUS_CLI_JS);
        expect(installer.status().stale).toBe(false);
    });

    posixIt('does not clobber a real (non-symlink) file at the bin path', () => {
        const p = installer.getPaths();
        realFs.mkdirSync(p.binDir, { recursive: true });
        realFs.writeFileSync(p.binPath, '#!/bin/sh\necho mine\n', 'utf-8');

        const result = installer.enable();
        expect(realFs.readFileSync(p.binPath, 'utf-8')).toContain('echo mine');
        expect(result.warnings.some((w) => w.includes(p.binPath))).toBe(true);
    });

    posixIt('does not clobber a foreign symlink at the bin path (e.g. another tool named nexus)', () => {
        const p = installer.getPaths();
        const otherTool = realPath.join(TEST_HOME, 'other-nexus.sh');
        realFs.writeFileSync(otherTool, '#!/bin/sh\necho other\n', 'utf-8');
        realFs.mkdirSync(p.binDir, { recursive: true });
        realFs.symlinkSync(otherTool, p.binPath);

        const result = installer.enable();
        expect(realFs.readlinkSync(p.binPath)).toBe(otherTool);
        expect(result.warnings.some((w) => w.includes(p.binPath))).toBe(true);
    });

    posixIt('uninstall() preserves a foreign symlink at the bin path', () => {
        const p = installer.getPaths();
        installer.enable();
        // Simulate the user replacing our PATH entry with their own tool afterward.
        const otherTool = realPath.join(TEST_HOME, 'other-nexus.sh');
        realFs.writeFileSync(otherTool, '#!/bin/sh\necho other\n', 'utf-8');
        realFs.unlinkSync(p.binPath);
        realFs.symlinkSync(otherTool, p.binPath);

        installer.uninstall();
        expect(realFs.existsSync(p.dataDir)).toBe(false);
        expect(realFs.readlinkSync(p.binPath)).toBe(otherTool);
    });

    posixIt('replaces our own dangling symlink on reinstall', () => {
        const p = installer.getPaths();
        realFs.mkdirSync(p.binDir, { recursive: true });
        // Our link from a previous install whose dataDir was wiped.
        realFs.symlinkSync(p.cliJsPath, p.binPath);

        const result = installer.enable();
        expect(realFs.realpathSync(p.binPath)).toBe(realFs.realpathSync(p.cliJsPath));
        expect(result.warnings.some((w) => w.includes(p.binPath) && w.includes('Skipped'))).toBe(false);
    });

    posixIt('uninstall() removes our artifacts and strips the Codex block while preserving other content', () => {
        const p = installer.getPaths();
        realFs.writeFileSync(p.codexAgentsPath, '# My Codex rules\nKeep this line.\n', 'utf-8');

        installer.enable();
        expect(realFs.readFileSync(p.codexAgentsPath, 'utf-8')).toContain('Nexus vault access');

        installer.uninstall();
        expect(realFs.existsSync(p.cliJsPath)).toBe(false);
        expect(realFs.existsSync(p.dataDir)).toBe(false);
        expect(realFs.existsSync(p.binPath)).toBe(false);
        expect(realFs.existsSync(p.claudeSkillLink)).toBe(false);
        expect(realFs.existsSync(p.cursorSkillLink)).toBe(false);

        const codex = realFs.readFileSync(p.codexAgentsPath, 'utf-8');
        expect(codex).toContain('Keep this line.');
        expect(codex).not.toContain('Nexus vault access');
    });

    describe('on Windows', () => {
        beforeEach(() => {
            const platform = jest.requireMock('obsidian').Platform as {
                isWin: boolean;
                isMacOS: boolean;
            };
            platform.isWin = true;
            platform.isMacOS = false;
            process.env.LOCALAPPDATA = realPath.join(TEST_HOME, 'AppData', 'Local');
            process.env.PATH = 'C:\\Windows\\System32';
        });

        it('enable() persists the CLI directory in the user PATH and reports it accurately', () => {
            mockSpawnSync.mockReturnValue({ status: 0, stdout: 'ADDED\n', stderr: '' });

            const result = installer.enable({ claudeCode: false, cursor: false, codex: false });
            const paths = installer.getPaths();

            expect(mockSpawnSync).toHaveBeenCalledWith(
                'powershell.exe',
                expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command']),
                expect.objectContaining({
                    windowsHide: true,
                    env: expect.objectContaining({ NEXUS_CLI_BIN_DIR: paths.binDir }),
                })
            );
            expect(realFs.existsSync(paths.binPath)).toBe(true);
            expect(realFs.existsSync(paths.pathMarkerPath)).toBe(true);
            expect(process.env.PATH?.toLowerCase()).toContain(paths.binDir.toLowerCase());
            expect(installer.status().onPath).toBe(true);
            expect(result.warnings).toEqual([]);
        });

        it('uninstall() removes a PATH entry that Nexus added', () => {
            mockSpawnSync
                .mockReturnValueOnce({ status: 0, stdout: 'ADDED\n', stderr: '' })
                .mockReturnValueOnce({ status: 0, stdout: 'REMOVED\n', stderr: '' });

            installer.enable({ claudeCode: false, cursor: false, codex: false });
            const paths = installer.getPaths();
            const result = installer.uninstall();

            expect(mockSpawnSync).toHaveBeenCalledTimes(2);
            expect(process.env.PATH?.toLowerCase()).not.toContain(paths.binDir.toLowerCase());
            expect(result.warnings).toEqual([]);
        });

        it('reconcile() never changes the user PATH without an explicit action', () => {
            mockSpawnSync.mockReturnValue({ status: 0, stdout: 'PRESENT\n', stderr: '' });
            installer.enable({ claudeCode: false, cursor: false, codex: false });
            process.env.PATH = 'C:\\Windows\\System32';
            mockSpawnSync.mockReset();

            installer.reconcile();

            expect(mockSpawnSync).not.toHaveBeenCalled();
            expect(installer.status().onPath).toBe(false);
        });

        it('supports an explicit PATH repair for an existing install', () => {
            mockSpawnSync
                .mockReturnValueOnce({ status: 0, stdout: 'PRESENT\n', stderr: '' })
                .mockReturnValueOnce({ status: 0, stdout: 'ADDED\n', stderr: '' });
            installer.enable({ claudeCode: false, cursor: false, codex: false });
            process.env.PATH = 'C:\\Windows\\System32';

            const result = installer.addToWindowsUserPath();

            expect(result.warnings).toEqual([]);
            expect(installer.status().onPath).toBe(true);
        });

        it('uninstall() preserves a PATH entry that was already user-managed', () => {
            const paths = installer.getPaths();
            process.env.PATH = `${process.env.PATH};${paths.binDir}`;
            mockSpawnSync.mockReturnValue({ status: 0, stdout: 'PRESENT\n', stderr: '' });

            installer.enable({ claudeCode: false, cursor: false, codex: false });
            expect(realFs.existsSync(paths.pathMarkerPath)).toBe(false);

            installer.uninstall();

            expect(mockSpawnSync).toHaveBeenCalledTimes(1);
            expect(process.env.PATH?.toLowerCase()).toContain(paths.binDir.toLowerCase());
        });

        it('keeps the install but reports PATH persistence failures', () => {
            mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'registry denied' });

            const result = installer.enable({ claudeCode: false, cursor: false, codex: false });
            const paths = installer.getPaths();

            expect(realFs.existsSync(paths.binPath)).toBe(true);
            expect(installer.status().onPath).toBe(false);
            expect(result.warnings).toEqual([
                expect.stringContaining('registry denied'),
            ]);
        });

        it('retains its PATH ownership marker when cleanup fails', () => {
            mockSpawnSync
                .mockReturnValueOnce({ status: 0, stdout: 'ADDED\n', stderr: '' })
                .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'registry denied' });
            installer.enable({ claudeCode: false, cursor: false, codex: false });
            const paths = installer.getPaths();

            const result = installer.uninstall();

            expect(realFs.existsSync(paths.pathMarkerPath)).toBe(true);
            expect(realFs.existsSync(paths.dataDir)).toBe(true);
            expect(result.warnings).toEqual(expect.arrayContaining([
                expect.stringContaining('registry denied'),
                expect.stringContaining('cleanup can be retried safely'),
            ]));
        });
    });
});
