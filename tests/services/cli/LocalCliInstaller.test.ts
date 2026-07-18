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
        return mod;
    },
}));

import { LocalCliInstaller } from '../../../src/services/cli/LocalCliInstaller';
import { NEXUS_CLI_JS } from '../../../src/utils/cliAssets';

describe('LocalCliInstaller', () => {
    let installer: LocalCliInstaller;

    beforeEach(() => {
        TEST_HOME = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'nexus-cli-test-'));
        // Simulate both agents being installed so detection fires.
        realFs.mkdirSync(realPath.join(TEST_HOME, '.claude'), { recursive: true });
        realFs.mkdirSync(realPath.join(TEST_HOME, '.codex'), { recursive: true });
        installer = new LocalCliInstaller();
    });

    afterEach(() => {
        realFs.rmSync(TEST_HOME, { recursive: true, force: true });
    });

    it('enable() writes the CLI, skill, PATH symlink, Claude skill link, and Codex block', () => {
        const result = installer.enable();
        const p = installer.getPaths();

        expect(realFs.readFileSync(p.cliJsPath, 'utf-8')).toBe(NEXUS_CLI_JS);
        expect(realFs.readFileSync(p.skillMdPath, 'utf-8')).toContain('# Nexus vault CLI');
        expect(realFs.lstatSync(p.binPath).isSymbolicLink()).toBe(true);
        expect(realFs.realpathSync(p.binPath)).toBe(realFs.realpathSync(p.cliJsPath));
        expect(realFs.lstatSync(p.claudeSkillLink).isSymbolicLink()).toBe(true);
        expect(realFs.readFileSync(p.codexAgentsPath, 'utf-8')).toContain('Nexus vault access');
        expect(result.created).toContain(p.cliJsPath);
        expect(result.detected).toEqual({ claudeCode: true, codex: true });
    });

    it('status() reflects an installed, on-PATH, linked state', () => {
        installer.enable();
        const s = installer.status();
        expect(s.installed).toBe(true);
        expect(s.onPath).toBe(true);
        expect(s.stale).toBe(false);
        expect(s.skillLinked).toBe(true);
        expect(s.codexLinked).toBe(true);
    });

    it('reconcile() refreshes a stale on-disk CLI copy', () => {
        installer.enable();
        const p = installer.getPaths();
        realFs.writeFileSync(p.cliJsPath, '// stale content', 'utf-8');
        expect(installer.status().stale).toBe(true);

        const changed = installer.reconcile();
        expect(changed).toBe(true);
        expect(realFs.readFileSync(p.cliJsPath, 'utf-8')).toBe(NEXUS_CLI_JS);
        expect(installer.status().stale).toBe(false);
    });

    it('does not clobber a real (non-symlink) file at the bin path', () => {
        const p = installer.getPaths();
        realFs.mkdirSync(p.binDir, { recursive: true });
        realFs.writeFileSync(p.binPath, '#!/bin/sh\necho mine\n', 'utf-8');

        const result = installer.enable();
        expect(realFs.readFileSync(p.binPath, 'utf-8')).toContain('echo mine');
        expect(result.warnings.some((w) => w.includes(p.binPath))).toBe(true);
    });

    it('uninstall() removes our artifacts and strips the Codex block while preserving other content', () => {
        const p = installer.getPaths();
        realFs.writeFileSync(p.codexAgentsPath, '# My Codex rules\nKeep this line.\n', 'utf-8');

        installer.enable();
        expect(realFs.readFileSync(p.codexAgentsPath, 'utf-8')).toContain('Nexus vault access');

        installer.uninstall();
        expect(realFs.existsSync(p.cliJsPath)).toBe(false);
        expect(realFs.existsSync(p.dataDir)).toBe(false);
        expect(realFs.existsSync(p.binPath)).toBe(false);
        expect(realFs.existsSync(p.claudeSkillLink)).toBe(false);

        const codex = realFs.readFileSync(p.codexAgentsPath, 'utf-8');
        expect(codex).toContain('Keep this line.');
        expect(codex).not.toContain('Nexus vault access');
    });
});
