/**
 * LocalCliInstaller — installs the standalone `nexus` CLI + agent discovery
 * artifacts into machine-global locations so external coding agents (Claude
 * Code, Codex) can drive the vault with no MCP configuration.
 *
 * Design: docs/plans/local-cli-agent-bridge-plan.md
 *
 * What it creates (all outside the vault, only on explicit user action):
 *   <dataDir>/nexus-cli.js         the bundled CLI (chmod +x)
 *   <dataDir>/skill/SKILL.md       the Claude Code skill body
 *   <binDir>/nexus                 symlink → the CLI (PATH)
 *   ~/.claude/skills/nexus         symlink → <dataDir>/skill   (if Claude Code present)
 *   ~/.codex/AGENTS.md             marker-delimited pointer block (if Codex present)
 *
 * Desktop-only. Every filesystem call is lazy (desktopRequire) so importing this
 * module never touches Node built-ins on mobile.
 */
import { Platform } from 'obsidian';
import { desktopRequire } from '../../utils/desktopRequire';
import { NEXUS_CLI_JS, NEXUS_SKILL_MD, NEXUS_AGENTS_MD, NEXUS_PLAYBOOKS } from '../../utils/cliAssets';

type FsModule = typeof import('node:fs');
type OsModule = typeof import('node:os');
type PathModule = typeof import('node:path');

const AGENTS_BEGIN = '<!-- BEGIN nexus-cli (managed by Nexus plugin) -->';
const AGENTS_END = '<!-- END nexus-cli -->';

export interface DetectedAgents {
    claudeCode: boolean;
    codex: boolean;
}

export interface CliInstallPaths {
    dataDir: string;
    cliJsPath: string;
    skillDir: string;
    skillMdPath: string;
    playbooksDir: string;
    binDir: string;
    binPath: string;
    claudeSkillLink: string;
    codexAgentsPath: string;
}

export interface CliInstallStatus {
    supported: boolean;
    installed: boolean;
    onPath: boolean;
    stale: boolean;
    skillLinked: boolean;
    codexLinked: boolean;
    detected: DetectedAgents;
    paths: CliInstallPaths;
}

export interface CliInstallResult {
    created: string[];
    warnings: string[];
    detected: DetectedAgents;
}

export class LocalCliInstaller {
    private fs(): FsModule { return desktopRequire<FsModule>('node:fs'); }
    private os(): OsModule { return desktopRequire<OsModule>('node:os'); }
    private path(): PathModule { return desktopRequire<PathModule>('node:path'); }

    /** True on desktop where Node fs/os/path are available. */
    isSupported(): boolean {
        return Platform.isDesktop;
    }

    getPaths(): CliInstallPaths {
        const path = this.path();
        const home = this.os().homedir();
        const dataDir = Platform.isWin
            ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'nexus')
            : path.join(home, '.local', 'share', 'nexus');
        const binDir = Platform.isWin ? dataDir : path.join(home, '.local', 'bin');
        const skillDir = path.join(dataDir, 'skill');
        return {
            dataDir,
            cliJsPath: path.join(dataDir, 'nexus-cli.js'),
            skillDir,
            skillMdPath: path.join(skillDir, 'SKILL.md'),
            playbooksDir: path.join(skillDir, 'playbooks'),
            binDir,
            binPath: path.join(binDir, Platform.isWin ? 'nexus.cmd' : 'nexus'),
            claudeSkillLink: path.join(home, '.claude', 'skills', 'nexus'),
            codexAgentsPath: path.join(home, '.codex', 'AGENTS.md'),
        };
    }

    detectAgents(): DetectedAgents {
        const fs = this.fs();
        const path = this.path();
        const home = this.os().homedir();
        return {
            claudeCode: fs.existsSync(path.join(home, '.claude')),
            codex: fs.existsSync(path.join(home, '.codex')),
        };
    }

    status(): CliInstallStatus {
        if (!this.isSupported()) {
            return {
                supported: false, installed: false, onPath: false, stale: false,
                skillLinked: false, codexLinked: false,
                detected: { claudeCode: false, codex: false },
                paths: {} as CliInstallPaths,
            };
        }
        const fs = this.fs();
        const paths = this.getPaths();
        const installed = fs.existsSync(paths.cliJsPath);
        let stale = false;
        if (installed) {
            try {
                stale = fs.readFileSync(paths.cliJsPath, 'utf-8') !== NEXUS_CLI_JS
                    || (!fs.existsSync(paths.skillMdPath) || fs.readFileSync(paths.skillMdPath, 'utf-8') !== NEXUS_SKILL_MD)
                    || this.playbooksStale(paths);
            } catch { stale = true; }
        }
        return {
            supported: true,
            installed,
            onPath: this.pointsTo(paths.binPath, paths.cliJsPath),
            stale,
            skillLinked: this.pointsTo(paths.claudeSkillLink, paths.skillDir),
            codexLinked: this.hasCodexBlock(paths.codexAgentsPath),
            detected: this.detectAgents(),
            paths,
        };
    }

    /** Human-readable list of exactly what enable() will create, for disclosure before acting. */
    describePlan(): string[] {
        if (!this.isSupported()) return ['Local CLI install requires desktop.'];
        const paths = this.getPaths();
        const detected = this.detectAgents();
        const lines = [
            `CLI binary: ${paths.cliJsPath}`,
            `On PATH:    ${paths.binPath} → nexus-cli.js`,
        ];
        if (detected.claudeCode) lines.push(`Claude Code skill: ${paths.claudeSkillLink} → ${paths.skillDir}`);
        if (detected.codex) lines.push(`Codex pointer: appended to ${paths.codexAgentsPath}`);
        if (!detected.claudeCode && !detected.codex) {
            lines.push('No Claude Code (~/.claude) or Codex (~/.codex) detected — only the CLI will be installed.');
        }
        return lines;
    }

    enable(): CliInstallResult {
        if (!this.isSupported()) throw new Error('Local CLI install is desktop-only.');
        const fs = this.fs();
        const paths = this.getPaths();
        const detected = this.detectAgents();
        const created: string[] = [];
        const warnings: string[] = [];

        // 1. CLI binary
        fs.mkdirSync(paths.dataDir, { recursive: true });
        fs.writeFileSync(paths.cliJsPath, NEXUS_CLI_JS, 'utf-8');
        try { fs.chmodSync(paths.cliJsPath, 0o755); } catch { /* best effort */ }
        created.push(paths.cliJsPath);

        // 2. Skill body + playbooks
        fs.mkdirSync(paths.skillDir, { recursive: true });
        fs.writeFileSync(paths.skillMdPath, NEXUS_SKILL_MD, 'utf-8');
        created.push(paths.skillMdPath);
        if (this.writePlaybooks(paths)) created.push(paths.playbooksDir);

        // 3. PATH entry
        if (Platform.isWin) {
            // Windows: a .cmd shim (symlinks need elevation); user adds dataDir to PATH.
            const shim = `@echo off\r\nnode "%~dp0nexus-cli.js" %*\r\n`;
            fs.writeFileSync(paths.binPath, shim, 'utf-8');
            created.push(paths.binPath);
            warnings.push(`Add ${paths.binDir} to your PATH to call \`nexus\` directly.`);
        } else {
            fs.mkdirSync(paths.binDir, { recursive: true });
            if (this.linkReplace(paths.binPath, paths.cliJsPath, warnings)) created.push(paths.binPath);
            if (!this.dirOnPath(paths.binDir)) {
                warnings.push(`${paths.binDir} is not on your PATH — add it, or call the CLI by full path.`);
            }
        }

        // 4. Claude Code skill
        if (detected.claudeCode) {
            fs.mkdirSync(this.path().dirname(paths.claudeSkillLink), { recursive: true });
            if (Platform.isWin) {
                this.copyDir(paths.skillDir, paths.claudeSkillLink);
                created.push(paths.claudeSkillLink);
            } else if (this.linkReplace(paths.claudeSkillLink, paths.skillDir, warnings)) {
                created.push(paths.claudeSkillLink);
            }
        }

        // 5. Codex pointer
        if (detected.codex) {
            this.writeCodexBlock(paths.codexAgentsPath);
            created.push(paths.codexAgentsPath);
        }

        return { created, warnings, detected };
    }

    uninstall(): CliInstallResult {
        if (!this.isSupported()) throw new Error('Local CLI install is desktop-only.');
        const fs = this.fs();
        const paths = this.getPaths();
        const created: string[] = [];
        const warnings: string[] = [];

        // Remove our symlinks only if they still point at us; never clobber user files.
        for (const [link, target] of [
            [paths.binPath, paths.cliJsPath] as const,
            [paths.claudeSkillLink, paths.skillDir] as const,
        ]) {
            if (this.pointsTo(link, target) || this.isOurSymlink(link)) {
                try { fs.rmSync(link, { recursive: true, force: true }); created.push(link); }
                catch (e) { warnings.push(`Could not remove ${link}: ${(e as Error).message}`); }
            }
        }
        // Windows shim / copied skill are real files — remove by path if present.
        if (Platform.isWin) {
            for (const p of [paths.binPath, paths.claudeSkillLink]) {
                try { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); created.push(p); } } catch { /* ignore */ }
            }
        }

        this.removeCodexBlock(paths.codexAgentsPath);

        try {
            if (fs.existsSync(paths.dataDir)) { fs.rmSync(paths.dataDir, { recursive: true, force: true }); created.push(paths.dataDir); }
        } catch (e) { warnings.push(`Could not remove ${paths.dataDir}: ${(e as Error).message}`); }

        return { created, warnings, detected: this.detectAgents() };
    }

    /** Idempotent refresh of an already-installed CLI/skill when the embedded content changed. */
    reconcile(): boolean {
        if (!this.isSupported()) return false;
        const fs = this.fs();
        const paths = this.getPaths();
        if (!fs.existsSync(paths.cliJsPath)) return false; // not installed → nothing to refresh
        let changed = false;
        try {
            if (fs.readFileSync(paths.cliJsPath, 'utf-8') !== NEXUS_CLI_JS) {
                fs.writeFileSync(paths.cliJsPath, NEXUS_CLI_JS, 'utf-8');
                try { fs.chmodSync(paths.cliJsPath, 0o755); } catch { /* best effort */ }
                changed = true;
            }
            if (!fs.existsSync(paths.skillMdPath) || fs.readFileSync(paths.skillMdPath, 'utf-8') !== NEXUS_SKILL_MD) {
                fs.mkdirSync(paths.skillDir, { recursive: true });
                fs.writeFileSync(paths.skillMdPath, NEXUS_SKILL_MD, 'utf-8');
                changed = true;
            }
            if (this.playbooksStale(paths)) {
                this.writePlaybooks(paths);
                changed = true;
            }
        } catch { /* refresh is best-effort */ }
        return changed;
    }

    /** Write every embedded playbook to <skillDir>/playbooks/. Returns true if any were written. */
    private writePlaybooks(paths: CliInstallPaths): boolean {
        const fs = this.fs();
        const entries = Object.entries(NEXUS_PLAYBOOKS);
        if (entries.length === 0) return false;
        fs.mkdirSync(paths.playbooksDir, { recursive: true });
        for (const [file, content] of entries) {
            fs.writeFileSync(this.path().join(paths.playbooksDir, file), content, 'utf-8');
        }
        return true;
    }

    /** True if any embedded playbook is missing on disk or differs from the embedded copy. */
    private playbooksStale(paths: CliInstallPaths): boolean {
        const fs = this.fs();
        for (const [file, content] of Object.entries(NEXUS_PLAYBOOKS)) {
            const p = this.path().join(paths.playbooksDir, file);
            try {
                if (!fs.existsSync(p) || fs.readFileSync(p, 'utf-8') !== content) return true;
            } catch { return true; }
        }
        return false;
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    /** Create/replace a symlink at `link` → `target`. Returns true if we own it afterward. */
    private linkReplace(link: string, target: string, warnings: string[]): boolean {
        const fs = this.fs();
        try {
            if (fs.existsSync(link) || this.isSymlink(link)) {
                if (this.isSymlink(link)) {
                    fs.unlinkSync(link);
                } else {
                    warnings.push(`Skipped ${link} — a real file/folder already exists there (not overwriting).`);
                    return false;
                }
            }
            fs.symlinkSync(target, link);
            return true;
        } catch (e) {
            warnings.push(`Could not link ${link}: ${(e as Error).message}`);
            return false;
        }
    }

    private isSymlink(p: string): boolean {
        try { return this.fs().lstatSync(p).isSymbolicLink(); } catch { return false; }
    }

    private isOurSymlink(link: string): boolean {
        // A symlink we created whose target is missing still reads back as a symlink.
        return this.isSymlink(link);
    }

    private pointsTo(link: string, target: string): boolean {
        const fs = this.fs();
        try {
            if (!this.isSymlink(link)) return false;
            return this.path().resolve(fs.readlinkSync(link)) === this.path().resolve(target);
        } catch { return false; }
    }

    private dirOnPath(dir: string): boolean {
        const entries = (process.env.PATH || '').split(this.path().delimiter);
        const norm = this.path().resolve(dir);
        return entries.some((e) => { try { return this.path().resolve(e) === norm; } catch { return false; } });
    }

    private copyDir(src: string, dest: string): void {
        const fs = this.fs();
        fs.mkdirSync(dest, { recursive: true });
        for (const name of fs.readdirSync(src)) {
            const s = this.path().join(src, name);
            const d = this.path().join(dest, name);
            if (fs.statSync(s).isDirectory()) this.copyDir(s, d);
            else fs.copyFileSync(s, d);
        }
    }

    private hasCodexBlock(agentsPath: string): boolean {
        const fs = this.fs();
        try { return fs.existsSync(agentsPath) && fs.readFileSync(agentsPath, 'utf-8').includes(AGENTS_BEGIN); }
        catch { return false; }
    }

    private writeCodexBlock(agentsPath: string): void {
        const fs = this.fs();
        fs.mkdirSync(this.path().dirname(agentsPath), { recursive: true });
        const block = `${AGENTS_BEGIN}\n${NEXUS_AGENTS_MD.trim()}\n${AGENTS_END}`;
        let content = '';
        try { content = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf-8') : ''; } catch { content = ''; }
        if (content.includes(AGENTS_BEGIN) && content.includes(AGENTS_END)) {
            content = content.replace(
                new RegExp(`${escapeRe(AGENTS_BEGIN)}[\\s\\S]*?${escapeRe(AGENTS_END)}`),
                block
            );
        } else {
            content = content.trimEnd() + (content.trim() ? '\n\n' : '') + block + '\n';
        }
        fs.writeFileSync(agentsPath, content, 'utf-8');
    }

    private removeCodexBlock(agentsPath: string): void {
        const fs = this.fs();
        try {
            if (!fs.existsSync(agentsPath)) return;
            const content = fs.readFileSync(agentsPath, 'utf-8');
            if (!content.includes(AGENTS_BEGIN)) return;
            const stripped = content
                .replace(new RegExp(`\\n*${escapeRe(AGENTS_BEGIN)}[\\s\\S]*?${escapeRe(AGENTS_END)}\\n*`), '\n')
                .trimEnd() + '\n';
            fs.writeFileSync(agentsPath, stripped, 'utf-8');
        } catch { /* best effort */ }
    }
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
