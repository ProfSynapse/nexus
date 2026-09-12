import { sanitizeVaultName } from '../utils/vaultUtils';

export const BRAND_NAME = 'Nexus';
export const LEGACY_BRAND_NAME = 'Claudesidian';

export const PLUGIN_IDS = {
    current: 'nexus',
    legacy: ['claudesidian-mcp']
} as const;

export const SERVER_KEY_PREFIXES = {
    current: 'nexus',
    legacy: ['claudesidian-mcp']
} as const;

export const PIPE_NAME_PREFIXES = {
    current: 'nexus_mcp',
    legacy: ['claudesidian_mcp']
} as const;

export const CHAT_VIEW_TYPES = {
    current: 'nexus-chat',
    legacy: ['claudesidian-chat']
} as const;

export const SERVER_LABELS = {
    current: 'nexus',
    legacy: ['claudesidian']
} as const;

export function getAllPluginIds(): string[] {
    return [PLUGIN_IDS.current, ...PLUGIN_IDS.legacy];
}

export function getAllServerKeyPrefixes(): string[] {
    return [SERVER_KEY_PREFIXES.current, ...SERVER_KEY_PREFIXES.legacy];
}

export function getAllPipePrefixes(): string[] {
    return [PIPE_NAME_PREFIXES.current, ...PIPE_NAME_PREFIXES.legacy];
}

export function getAllServerLabels(): string[] {
    return [SERVER_LABELS.current, ...SERVER_LABELS.legacy];
}

export function buildServerKeyFromSanitized(
    sanitizedVaultName: string,
    prefix: string
): string {
    return `${prefix}-${sanitizedVaultName}`;
}

export function getServerKeyCandidates(vaultName: string): string[] {
    const sanitized = sanitizeVaultName(vaultName);
    const prefixes = Array.from(new Set(getAllServerKeyPrefixes()));
    return prefixes.map(prefix => buildServerKeyFromSanitized(sanitized, prefix));
}

export function getPrimaryServerKey(vaultName: string): string {
    const sanitized = sanitizeVaultName(vaultName);
    return buildServerKeyFromSanitized(sanitized, SERVER_KEY_PREFIXES.current);
}

export function buildIpcPath(
    sanitizedVaultName: string,
    isWindows: boolean,
    prefix: string
): string {
    return isWindows
        ? `\\\\.\\pipe\\${prefix}_${sanitizedVaultName}`
        : `/tmp/${prefix}_${sanitizedVaultName}.sock`;
}

export function getIpcPathCandidates(
    vaultName: string,
    isWindows: boolean
): string[] {
    const sanitized = sanitizeVaultName(vaultName);
    const prefixes = Array.from(new Set(getAllPipePrefixes()));
    return prefixes.map(prefix => buildIpcPath(sanitized, isWindows, prefix));
}

export function getPrimaryIpcPath(vaultName: string, isWindows: boolean): string {
    const sanitized = sanitizeVaultName(vaultName);
    return buildIpcPath(sanitized, isWindows, PIPE_NAME_PREFIXES.current);
}

/**
 * Where a running plugin publishes its vault's folder for the CLI.
 *
 * Sits beside the socket on Unix (`/tmp/nexus_mcp_<vault>.json`). The Windows
 * pipe namespace holds no files, so there it goes under the temp directory the
 * caller passes (`os.tmpdir()`, i.e. %TEMP%). `cli/vaultDiscovery.ts` mirrors
 * this shape and must stay identical.
 */
export function buildVaultNotePath(
    sanitizedVaultName: string,
    isWindows: boolean,
    windowsTempDir: string
): string {
    const fileName = `${PIPE_NAME_PREFIXES.current}_${sanitizedVaultName}.json`;
    return isWindows
        ? `${windowsTempDir.replace(/[\\/]+$/, '')}\\${fileName}`
        : `/tmp/${fileName}`;
}

export function getPrimaryVaultNotePath(
    vaultName: string,
    isWindows: boolean,
    windowsTempDir: string
): string {
    return buildVaultNotePath(sanitizeVaultName(vaultName), isWindows, windowsTempDir);
}
