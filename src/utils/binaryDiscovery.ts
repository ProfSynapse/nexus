import { Platform } from 'obsidian';

const COMMON_UNIX_BIN_DIRS = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/opt/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
];

const COMMON_WINDOWS_BIN_DIRS = [
    'C:\\Program Files\\nodejs',
    'C:\\Program Files\\Claude',
    'C:\\Program Files\\Anthropic\\Claude'
];

export function resolveDesktopBinaryPath(binaryName: string): string | null {
    if (!Platform.isDesktop) {
        return null;
    }

    const fromPath = resolveFromCurrentPath(binaryName);
    if (fromPath) {
        return fromPath;
    }

    const fromCommonLocations = resolveFromCommonLocations(binaryName);
    if (fromCommonLocations) {
        return fromCommonLocations;
    }

    return resolveFromLoginShell(binaryName);
}

function resolveFromCurrentPath(binaryName: string): string | null {
    if (!Platform.isDesktop) {
        return null;
    }

    try {
        const childProcess = require('child_process') as typeof import('child_process');
        const nodeFs = require('fs') as typeof import('fs');
        const command = Platform.isWin ? `where ${binaryName}` : `which ${binaryName}`;
        const result = childProcess.execSync(command, {
            encoding: 'utf8',
            timeout: 5000,
            env: { ...process.env }
        }).trim();

        const firstLine = result.split(/\r?\n/)[0]?.trim();
        if (firstLine && nodeFs.existsSync(firstLine)) {
            return firstLine;
        }
    } catch {
        // Fall through to deterministic location checks.
    }

    return null;
}

function resolveFromCommonLocations(binaryName: string): string | null {
    if (!Platform.isDesktop) {
        return null;
    }

    try {
        const nodeFs = require('fs') as typeof import('fs');
        const pathMod = require('path') as typeof import('path');
        const binDirs = Platform.isWin ? COMMON_WINDOWS_BIN_DIRS : COMMON_UNIX_BIN_DIRS;
        const candidateNames = Platform.isWin ? [binaryName, `${binaryName}.exe`, `${binaryName}.cmd`] : [binaryName];

        for (const dir of binDirs) {
            for (const candidateName of candidateNames) {
                const candidate = pathMod.join(dir, candidateName);
                if (nodeFs.existsSync(candidate)) {
                    return candidate;
                }
            }
        }
    } catch {
        // Fall through to shell lookup.
    }

    return null;
}

function resolveFromLoginShell(binaryName: string): string | null {
    if (!Platform.isDesktop || Platform.isWin) {
        return null;
    }

    try {
        const childProcess = require('child_process') as typeof import('child_process');
        const nodeFs = require('fs') as typeof import('fs');
        const shell = process.env.SHELL || '/bin/zsh';
        const escapedBinaryName = binaryName.replace(/'/g, `'\\''`);
        const result = childProcess.execFileSync(
            shell,
            ['-lc', `command -v '${escapedBinaryName}'`],
            {
                encoding: 'utf8',
                timeout: 5000,
                env: { ...process.env }
            }
        ).trim();

        const firstLine = result.split(/\r?\n/)[0]?.trim();
        if (firstLine && nodeFs.existsSync(firstLine)) {
            return firstLine;
        }
    } catch {
        // No login-shell resolution available.
    }

    return null;
}
