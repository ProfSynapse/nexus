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

const WINDOWS_BINARY_PRIORITY = ['.exe', '.cmd', '.bat', '.com', ''];

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
    try {
        const childProcess = require('child_process') as typeof import('child_process');
        const nodeFs = require('fs') as typeof import('fs');
        const command = Platform.isWin ? `where.exe ${binaryName}` : `which ${binaryName}`;
        const result = childProcess.execSync(command, {
            encoding: 'utf8',
            timeout: 5000,
            env: { ...process.env }
        });

        const candidates = result
            .split(/\r?\n/u)
            .map((line: string) => line.trim())
            .filter(Boolean)
            .filter((candidate: string) => nodeFs.existsSync(candidate));

        if (candidates.length > 0) {
            return Platform.isWin
                ? chooseBestWindowsCandidate(candidates)
                : candidates[0] ?? null;
        }
    } catch {
        // Fall through to deterministic location checks.
    }

    return null;
}

function resolveFromCommonLocations(binaryName: string): string | null {
    try {
        const nodeFs = require('fs') as typeof import('fs');
        const pathMod = require('path') as typeof import('path');
        const binDirs = Platform.isWin ? COMMON_WINDOWS_BIN_DIRS : COMMON_UNIX_BIN_DIRS;
        const candidateNames = Platform.isWin
            ? [`${binaryName}.exe`, `${binaryName}.cmd`, `${binaryName}.bat`, binaryName]
            : [binaryName];

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

function chooseBestWindowsCandidate(candidates: string[]): string | null {
    const pathMod = require('path') as typeof import('path');

    const ranked = [...candidates].sort((left, right) => {
        const leftScore = WINDOWS_BINARY_PRIORITY.indexOf(pathMod.extname(left).toLowerCase());
        const rightScore = WINDOWS_BINARY_PRIORITY.indexOf(pathMod.extname(right).toLowerCase());
        const normalizedLeft = leftScore === -1 ? Number.MAX_SAFE_INTEGER : leftScore;
        const normalizedRight = rightScore === -1 ? Number.MAX_SAFE_INTEGER : rightScore;

        if (normalizedLeft !== normalizedRight) {
            return normalizedLeft - normalizedRight;
        }

        return left.localeCompare(right);
    });

    return ranked[0] ?? null;
}

function resolveFromLoginShell(binaryName: string): string | null {
    if (Platform.isWin) {
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

        const firstLine = result.split(/\r?\n/u)[0]?.trim();
        if (firstLine && nodeFs.existsSync(firstLine)) {
            return firstLine;
        }
    } catch {
        // No login-shell resolution available.
    }

    return null;
}
