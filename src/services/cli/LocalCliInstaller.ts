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
type ChildProcessModule = typeof import('node:child_process');

const AGENTS_BEGIN = '<!-- BEGIN nexus-cli (managed by Nexus plugin) -->';
const AGENTS_END = '<!-- END nexus-cli -->';

/** The agent providers the CLI can wire into. */
export type CliProviderId = 'claudeCode' | 'cursor' | 'codex';

export interface DetectedAgents {
    claudeCode: boolean;
    codex: boolean;
    cursor: boolean;
}

/** Which providers to wire the CLI skill/pointer into (defaults to whatever is detected). */
export type CliInstallTargets = Record<CliProviderId, boolean>;

export interface CliInstallPaths {
    dataDir: string;
    cliJsPath: string;
    skillDir: string;
    skillMdPath: string;
    playbooksDir: string;
    binDir: string;
    binPath: string;
    pathMarkerPath: string;
    claudeSkillLink: string;
    cursorSkillLink: string;
    codexAgentsPath: string;
}

export interface CliInstallStatus {
    supported: boolean;
    installed: boolean;
    onPath: boolean;
    stale: boolean;
    skillLinked: boolean;
    cursorLinked: boolean;
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
    private childProcess(): ChildProcessModule { return desktopRequire<ChildProcessModule>('node:child_process'); }

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
            pathMarkerPath: path.join(dataDir, '.path-managed'),
            claudeSkillLink: path.join(home, '.claude', 'skills', 'nexus'),
            cursorSkillLink: path.join(home, '.cursor', 'skills', 'nexus'),
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
            cursor: fs.existsSync(path.join(home, '.cursor')),
        };
    }

    /** The skill-symlink location for a skill-based provider (Claude Code, Cursor). */
    private skillLinkFor(id: 'claudeCode' | 'cursor', paths: CliInstallPaths): string {
        return id === 'cursor' ? paths.cursorSkillLink : paths.claudeSkillLink;
    }

    status(): CliInstallStatus {
        if (!this.isSupported()) {
            return {
                supported: false, installed: false, onPath: false, stale: false,
                skillLinked: false, cursorLinked: false, codexLinked: false,
                detected: { claudeCode: false, codex: false, cursor: false },
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
                    || this.playbooksStale(paths)
                    || this.codexBlockStale(paths.codexAgentsPath)
                    || this.winCopyStale(paths.claudeSkillLink)
                    || this.winCopyStale(paths.cursorSkillLink);
            } catch { stale = true; }
        }
        return {
            supported: true,
            installed,
            onPath: Platform.isWin
                ? fs.existsSync(paths.binPath) && this.dirOnPath(paths.binDir)
                : this.pointsTo(paths.binPath, paths.cliJsPath),
            stale,
            skillLinked: this.skillWired(paths.claudeSkillLink, paths),
            cursorLinked: this.skillWired(paths.cursorSkillLink, paths),
            codexLinked: this.hasCodexBlock(paths.codexAgentsPath),
            detected: this.detectAgents(),
            paths,
        };
    }

    /** Default install targets: wire whatever is detected on the machine. */
    private defaultTargets(): CliInstallTargets {
        const d = this.detectAgents();
        return { claudeCode: d.claudeCode, codex: d.codex, cursor: d.cursor };
    }

    /** Human-readable list of exactly what enable() will create, for disclosure before acting. */
    describePlan(targets?: Partial<CliInstallTargets>): string[] {
        if (!this.isSupported()) return ['Local CLI install requires desktop.'];
        const paths = this.getPaths();
        const t = { ...this.defaultTargets(), ...targets };
        const lines = [
            `CLI binary: ${paths.cliJsPath}`,
            Platform.isWin
                ? `Windows user PATH: ${paths.binDir}`
                : `On PATH:    ${paths.binPath} → nexus-cli.js`,
        ];
        if (t.claudeCode) lines.push(`Claude Code skill: ${paths.claudeSkillLink} → ${paths.skillDir}`);
        if (t.cursor) lines.push(`Cursor skill: ${paths.cursorSkillLink} → ${paths.skillDir}`);
        if (t.codex) lines.push(`Codex pointer: appended to ${paths.codexAgentsPath}`);
        if (!t.claudeCode && !t.cursor && !t.codex) {
            lines.push('No agent provider selected — only the nexus command will be installed.');
        }
        return lines;
    }

    /**
     * Install the `nexus` command and wire it into the selected agent providers.
     * `targets` defaults to whatever is detected on the machine; pass an explicit
     * selection (from the Get Started picker) to override per provider.
     */
    enable(targets?: Partial<CliInstallTargets>): CliInstallResult {
        if (!this.isSupported()) throw new Error('Local CLI install is desktop-only.');
        const fs = this.fs();
        const paths = this.getPaths();
        const detected = this.detectAgents();
        const t = { ...this.defaultTargets(), ...targets };
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
            // Windows: a .cmd shim (symlinks need elevation) plus a persistent,
            // per-user PATH entry. No admin rights are required.
            const shim = `@echo off\r\nnode "%~dp0nexus-cli.js" %*\r\n`;
            fs.writeFileSync(paths.binPath, shim, 'utf-8');
            created.push(paths.binPath);
            this.ensureWindowsUserPath(paths, created, warnings);
        } else {
            fs.mkdirSync(paths.binDir, { recursive: true });
            if (this.linkReplace(paths.binPath, paths.cliJsPath, warnings)) created.push(paths.binPath);
            if (!this.dirOnPath(paths.binDir)) {
                warnings.push(`${paths.binDir} is not on your PATH — add it, or call the CLI by full path.`);
            }
        }

        // 4. Skill-based providers (Claude Code, Cursor) — same skills mechanism,
        //    just different link locations. Both read the same skill dir.
        if (t.claudeCode) this.wireSkillLink(paths.claudeSkillLink, paths, created, warnings);
        if (t.cursor) this.wireSkillLink(paths.cursorSkillLink, paths, created, warnings);

        // 5. Codex pointer (AGENTS.md block).
        if (t.codex) {
            this.writeCodexBlock(paths.codexAgentsPath);
            created.push(paths.codexAgentsPath);
        }

        return { created, warnings, detected };
    }

    /**
     * Wire or unwire the CLI into a single provider after the CLI is installed
     * (from the Get Started provider checkboxes). No-op with a warning if the CLI
     * binary isn't installed yet.
     */
    setProvider(id: CliProviderId, enabled: boolean): CliInstallResult {
        if (!this.isSupported()) throw new Error('Local CLI install is desktop-only.');
        const fs = this.fs();
        const paths = this.getPaths();
        const created: string[] = [];
        const warnings: string[] = [];
        if (!fs.existsSync(paths.cliJsPath)) {
            warnings.push('Install the CLI first, then choose providers.');
            return { created, warnings, detected: this.detectAgents() };
        }
        if (id === 'codex') {
            if (enabled) { this.writeCodexBlock(paths.codexAgentsPath); created.push(paths.codexAgentsPath); }
            else this.removeCodexBlock(paths.codexAgentsPath);
        } else {
            const link = this.skillLinkFor(id, paths);
            if (enabled) this.wireSkillLink(link, paths, created, warnings);
            else this.unwireSkillLink(link, created, warnings);
        }
        return { created, warnings, detected: this.detectAgents() };
    }

    /** Create the skill symlink (or copy on Windows) at `link` → skillDir. */
    private wireSkillLink(link: string, paths: CliInstallPaths, created: string[], warnings: string[]): void {
        this.fs().mkdirSync(this.path().dirname(link), { recursive: true });
        if (Platform.isWin) {
            this.copyDir(paths.skillDir, link);
            created.push(link);
        } else if (this.linkReplace(link, paths.skillDir, warnings)) {
            created.push(link);
        }
    }

    /** Remove a skill link we own (symlink, or copied dir on Windows). */
    private unwireSkillLink(link: string, created: string[], warnings: string[]): void {
        const fs = this.fs();
        try {
            if (this.pointsTo(link, this.getPaths().skillDir) || this.isOurSymlink(link) || (Platform.isWin && fs.existsSync(link))) {
                fs.rmSync(link, { recursive: true, force: true });
                created.push(link);
            }
        } catch (e) { warnings.push(`Could not remove ${link}: ${(e as Error).message}`); }
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
            [paths.cursorSkillLink, paths.skillDir] as const,
        ]) {
            if (this.pointsTo(link, target) || this.isOurSymlink(link)) {
                try { fs.rmSync(link, { recursive: true, force: true }); created.push(link); }
                catch (e) { warnings.push(`Could not remove ${link}: ${(e as Error).message}`); }
            }
        }
        // Windows shim / copied skill are real files — remove by path if present.
        if (Platform.isWin) {
            for (const p of [paths.binPath, paths.claudeSkillLink, paths.cursorSkillLink]) {
                try { if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); created.push(p); } } catch { /* ignore */ }
            }
            const pathCleanupSucceeded = this.removeManagedWindowsUserPath(paths, created, warnings);
            if (!pathCleanupSucceeded) {
                warnings.push(`Retained ${paths.dataDir} so Windows PATH cleanup can be retried safely.`);
            }
        }

        this.removeCodexBlock(paths.codexAgentsPath);

        const preserveDataDir = Platform.isWin && fs.existsSync(paths.pathMarkerPath);
        if (!preserveDataDir) {
            try {
                if (fs.existsSync(paths.dataDir)) { fs.rmSync(paths.dataDir, { recursive: true, force: true }); created.push(paths.dataDir); }
            } catch (e) { warnings.push(`Could not remove ${paths.dataDir}: ${(e as Error).message}`); }
        }

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
            // The Claude Code skill is a symlink (always live), but the Codex block is
            // copied content — refresh it here too so it doesn't drift after an update.
            if (this.codexBlockStale(paths.codexAgentsPath)) {
                this.writeCodexBlock(paths.codexAgentsPath);
                changed = true;
            }
            // Windows skill "links" are independent copies (no symlink tracking) —
            // re-copy any wired provider whose content drifted from the embed.
            for (const link of [paths.claudeSkillLink, paths.cursorSkillLink]) {
                if (this.winCopyStale(link)) {
                    this.copyDir(paths.skillDir, link);
                    changed = true;
                }
            }
        } catch { /* refresh is best-effort */ }
        return changed;
    }

    /** Explicitly add an existing Windows install to the current user's PATH. */
    addToWindowsUserPath(): CliInstallResult {
        if (!this.isSupported() || !Platform.isWin) {
            throw new Error('Windows user PATH setup is available on Windows desktop only.');
        }
        const paths = this.getPaths();
        if (!this.fs().existsSync(paths.binPath)) {
            throw new Error('Install the Nexus CLI before adding it to PATH.');
        }
        const created: string[] = [];
        const warnings: string[] = [];
        this.ensureWindowsUserPath(paths, created, warnings);
        return { created, warnings, detected: this.detectAgents() };
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
                if (this.isOurSymlink(link)) {
                    fs.unlinkSync(link);
                } else if (this.isSymlink(link)) {
                    warnings.push(`Skipped ${link} — an existing symlink there points outside Nexus (not overwriting).`);
                    return false;
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

    /**
     * A symlink is ours only if its target resolves inside our dataDir — `nexus`
     * is a common command name, and a user's pre-existing symlink (another tool,
     * a version-manager shim) must never be replaced or uninstalled. Works for
     * dangling links too: readlink needs no live target.
     */
    private isOurSymlink(link: string): boolean {
        const fs = this.fs();
        const path = this.path();
        try {
            if (!this.isSymlink(link)) return false;
            const resolved = path.resolve(path.dirname(link), fs.readlinkSync(link));
            const dataDir = path.resolve(this.getPaths().dataDir);
            return resolved === dataDir || resolved.startsWith(dataDir + path.sep);
        } catch { return false; }
    }

    private pointsTo(link: string, target: string): boolean {
        const fs = this.fs();
        try {
            if (!this.isSymlink(link)) return false;
            return this.path().resolve(fs.readlinkSync(link)) === this.path().resolve(target);
        } catch { return false; }
    }

    /** True when a provider skill is wired: symlink on POSIX, copied dir on Windows. */
    private skillWired(link: string, paths: CliInstallPaths): boolean {
        if (Platform.isWin) {
            try { return this.fs().existsSync(this.path().join(link, 'SKILL.md')); } catch { return false; }
        }
        return this.pointsTo(link, paths.skillDir);
    }

    /** Windows only: a wired skill copy whose content no longer matches the embed. */
    private winCopyStale(link: string): boolean {
        if (!Platform.isWin) return false;
        const fs = this.fs();
        const path = this.path();
        try {
            const skillMd = path.join(link, 'SKILL.md');
            if (!fs.existsSync(skillMd)) return false; // not wired → nothing to refresh
            if (fs.readFileSync(skillMd, 'utf-8') !== NEXUS_SKILL_MD) return true;
            for (const [file, content] of Object.entries(NEXUS_PLAYBOOKS)) {
                const p = path.join(link, 'playbooks', file);
                if (!fs.existsSync(p) || fs.readFileSync(p, 'utf-8') !== content) return true;
            }
            return false;
        } catch { return true; }
    }

    private dirOnPath(dir: string): boolean {
        const entries = (process.env.PATH || '').split(this.path().delimiter);
        const norm = this.path().resolve(dir);
        return entries.some((e) => {
            try {
                const candidate = this.path().resolve(e);
                return Platform.isWin ? candidate.toLowerCase() === norm.toLowerCase() : candidate === norm;
            } catch { return false; }
        });
    }

    /** Persist the CLI directory in the current Windows user's PATH. */
    private ensureWindowsUserPath(paths: CliInstallPaths, created: string[], warnings: string[]): void {
        const fs = this.fs();
        const script = [
            '$target = $env:NEXUS_CLI_BIN_DIR',
            "$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
            "$entries = @($current -split ';' | Where-Object { $_ })",
            "$present = $entries | Where-Object { $_.TrimEnd('\\') -ieq $target.TrimEnd('\\') }",
            "if ($present) { Write-Output 'PRESENT'; exit 0 }",
            "$updated = (($entries + $target) -join ';')",
            "[Environment]::SetEnvironmentVariable('Path', $updated, 'User')",
            "Write-Output 'ADDED'",
        ].join('; ');
        try {
            const result = this.childProcess().spawnSync(
                'powershell.exe',
                ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
                {
                    encoding: 'utf-8',
                    timeout: 10_000,
                    windowsHide: true,
                    env: { ...process.env, NEXUS_CLI_BIN_DIR: paths.binDir },
                }
            );
            if (result.error || result.status !== 0) {
                const detail = result.error?.message || String(result.stderr || '').trim();
                warnings.push(`Could not add ${paths.binDir} to your Windows user PATH${detail ? `: ${detail}` : '.'}`);
                return;
            }
            this.setProcessPathEntry(paths.binDir, true);
            if (String(result.stdout || '').includes('ADDED')) {
                fs.writeFileSync(paths.pathMarkerPath, paths.binDir, 'utf-8');
                created.push(paths.pathMarkerPath);
            }
        } catch (error) {
            warnings.push(`Could not add ${paths.binDir} to your Windows user PATH: ${(error as Error).message}`);
        }
    }

    /** Remove the user-PATH entry only when this installer originally added it. */
    private removeManagedWindowsUserPath(paths: CliInstallPaths, created: string[], warnings: string[]): boolean {
        const fs = this.fs();
        if (!fs.existsSync(paths.pathMarkerPath)) return true;
        const script = [
            '$target = $env:NEXUS_CLI_BIN_DIR',
            "$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
            "$entries = @($current -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ine $target.TrimEnd('\\') })",
            "$updated = ($entries -join ';')",
            "[Environment]::SetEnvironmentVariable('Path', $updated, 'User')",
            "Write-Output 'REMOVED'",
        ].join('; ');
        try {
            const result = this.childProcess().spawnSync(
                'powershell.exe',
                ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
                {
                    encoding: 'utf-8',
                    timeout: 10_000,
                    windowsHide: true,
                    env: { ...process.env, NEXUS_CLI_BIN_DIR: paths.binDir },
                }
            );
            if (result.error || result.status !== 0) {
                const detail = result.error?.message || String(result.stderr || '').trim();
                warnings.push(`Could not remove ${paths.binDir} from your Windows user PATH${detail ? `: ${detail}` : '.'}`);
                return false;
            }
            this.setProcessPathEntry(paths.binDir, false);
            created.push(paths.pathMarkerPath);
            return true;
        } catch (error) {
            warnings.push(`Could not remove ${paths.binDir} from your Windows user PATH: ${(error as Error).message}`);
            return false;
        }
    }

    /** Keep this Obsidian process in sync so status updates immediately. */
    private setProcessPathEntry(dir: string, present: boolean): void {
        const delimiter = this.path().delimiter;
        const normalized = this.path().resolve(dir).toLowerCase();
        const entries = (process.env.PATH || '')
            .split(delimiter)
            .filter(Boolean)
            .filter((entry) => {
                try { return this.path().resolve(entry).toLowerCase() !== normalized; }
                catch { return true; }
            });
        if (present) entries.push(dir);
        process.env.PATH = entries.join(delimiter);
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

    /** True if a Codex block is present but its content differs from the current embed. */
    private codexBlockStale(agentsPath: string): boolean {
        if (!this.hasCodexBlock(agentsPath)) return false; // absent → nothing to refresh
        const fs = this.fs();
        const expected = `${AGENTS_BEGIN}\n${NEXUS_AGENTS_MD.trim()}\n${AGENTS_END}`;
        try { return !fs.readFileSync(agentsPath, 'utf-8').includes(expected); }
        catch { return true; }
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
