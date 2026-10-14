/**
 * Finds the Node.js binary that external agents will run the connector with.
 *
 * Desktop only. Node built-ins are loaded lazily through desktopRequire, so
 * importing this module never touches them on mobile.
 */
import { Platform } from 'obsidian';
import { desktopRequire } from './desktopRequire';
import { resolveDesktopBinaryPath } from './binaryDiscovery';

export interface NodeRuntime {
    /** Absolute path to the node binary. */
    path: string;
    /** `v24.11.0`, or an empty string when `--version` could not be read. */
    version: string;
    /** nvm paths change when the user switches versions, which breaks saved configs. */
    manager: 'nvm' | 'other';
}

const VERSION_TIMEOUT_MS = 3000;

export function resolveNodeRuntime(): NodeRuntime | null {
    if (!Platform.isDesktop) {
        return null;
    }

    const path = resolveDesktopBinaryPath('node');
    if (!path) {
        return null;
    }

    return {
        path,
        version: readNodeVersion(path),
        manager: detectNodeManager(path)
    };
}

/** `v24.11.0` from `node --version` output, or '' when it is not a version. */
export function parseNodeVersion(output: string): string {
    const match = /^v\d+\.\d+\.\d+\S*/.exec(output.trim());
    return match ? match[0] : '';
}

export function detectNodeManager(path: string): 'nvm' | 'other' {
    if (path.includes('/.nvm/versions/node/')) {
        return 'nvm';
    }
    // nvm-windows keeps versions under %APPDATA%\nvm\ (or %NVM_HOME%).
    if (/\\nvm\\/i.test(path)) {
        return 'nvm';
    }
    return 'other';
}

function readNodeVersion(path: string): string {
    try {
        const childProcess = desktopRequire<typeof import('node:child_process')>('node:child_process');
        const output = childProcess.execFileSync(path, ['--version'], {
            encoding: 'utf8',
            timeout: VERSION_TIMEOUT_MS,
            windowsHide: true
        });
        return parseNodeVersion(String(output));
    } catch {
        return '';
    }
}
