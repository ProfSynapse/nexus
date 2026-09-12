import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    formatAvailableVaults,
    listVaultSockets,
    parseVaultNote,
    parseWindowsPipeListing,
    readVaultNotes,
    resolveVaultByCwd,
    vaultNotePath,
    VaultEntry,
} from '../../cli/vaultDiscovery';

jest.mock('node:child_process', () => ({
    spawnSync: jest.fn(),
}));

const mockSpawnSync = spawnSync as jest.MockedFunction<typeof spawnSync>;

describe('Windows Nexus vault discovery', () => {
    beforeEach(() => mockSpawnSync.mockReset());

    it('parses, validates, deduplicates, and sorts Nexus pipe names', () => {
        const result = parseWindowsPipeListing([
            'random_pipe',
            'nexus_mcp_synaptic-labs',
            'nexus_mcp_professor-synapse',
            'nexus_mcp_synaptic-labs',
            'nexus_mcp_BadUppercase',
            'nexus_mcp_../escape',
            '',
        ].join('\r\n'));

        expect(result).toEqual([
            {
                name: 'professor-synapse',
                path: '\\\\.\\pipe\\nexus_mcp_professor-synapse',
            },
            {
                name: 'synaptic-labs',
                path: '\\\\.\\pipe\\nexus_mcp_synaptic-labs',
            },
        ]);
    });

    it('uses a fixed, non-interactive PowerShell command on Windows', () => {
        mockSpawnSync.mockReturnValue({
            pid: 1,
            output: [],
            status: 0,
            signal: null,
            stdout: 'nexus_mcp_synaptic-labs\r\n',
            stderr: '',
        });

        expect(listVaultSockets('win32')).toEqual([
            {
                name: 'synaptic-labs',
                path: '\\\\.\\pipe\\nexus_mcp_synaptic-labs',
            },
        ]);
        expect(mockSpawnSync).toHaveBeenCalledWith(
            'powershell.exe',
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', expect.any(String)],
            expect.objectContaining({
                encoding: 'utf8',
                timeout: 5_000,
                windowsHide: true,
            })
        );
        const script = mockSpawnSync.mock.calls[0][1]?.at(-1);
        expect(script).toBe("Get-ChildItem -LiteralPath '\\\\.\\pipe\\' -Name");
    });

    it('returns an empty list when enumeration succeeds with no Nexus pipes', () => {
        mockSpawnSync.mockReturnValue({
            pid: 1,
            output: [],
            status: 0,
            signal: null,
            stdout: 'other_pipe\r\n',
            stderr: '',
        });

        expect(listVaultSockets('win32')).toEqual([]);
    });

    it('fails visibly and preserves the direct-vault fallback', () => {
        mockSpawnSync.mockReturnValue({
            pid: 1,
            output: [],
            status: 1,
            signal: null,
            stdout: '',
            stderr: 'access denied',
        });

        expect(() => listVaultSockets('win32')).toThrow(
            'Could not enumerate Windows named pipes: access denied. Pass --vault <name> or set NEXUS_VAULT as a fallback.'
        );
    });
});

describe('Nexus vault help formatting', () => {
    it('shows a useful empty state when no vaults are open', () => {
        expect(formatAvailableVaults([])).toBe(
            '  (none detected — open Obsidian with Nexus enabled)'
        );
    });

    it('shows every available vault with aligned paths', () => {
        expect(formatAvailableVaults([
            { name: 'notes', path: '/tmp/nexus_mcp_notes.sock' },
            { name: 'research-vault', path: '/tmp/nexus_mcp_research-vault.sock' },
        ])).toBe([
            '  notes           /tmp/nexus_mcp_notes.sock',
            '  research-vault  /tmp/nexus_mcp_research-vault.sock',
        ].join('\n'));
    });

    it('adds the vault folder as a third column where a note was published', () => {
        expect(formatAvailableVaults([
            { name: 'notes', path: '/tmp/nexus_mcp_notes.sock', basePath: '/Users/me/Notes' },
            { name: 'research-vault', path: '/tmp/nexus_mcp_research-vault.sock' },
        ])).toBe([
            '  notes           /tmp/nexus_mcp_notes.sock           /Users/me/Notes',
            '  research-vault  /tmp/nexus_mcp_research-vault.sock',
        ].join('\n'));
    });
});

describe('Nexus vault note path', () => {
    it('sits beside the socket on Unix, swapping .sock for .json', () => {
        expect(vaultNotePath({ name: 'code', path: '/tmp/nexus_mcp_code.sock' }, 'darwin', '/ignored'))
            .toBe('/tmp/nexus_mcp_code.json');
        expect(vaultNotePath({ name: 'code', path: '/tmp/nexus_mcp_code.sock' }, 'linux', '/ignored'))
            .toBe('/tmp/nexus_mcp_code.json');
    });

    it('lives under %TEMP% on Windows because the pipe namespace holds no files', () => {
        const socket = { name: 'code', path: '\\\\.\\pipe\\nexus_mcp_code' };
        expect(vaultNotePath(socket, 'win32', 'C:\\Users\\me\\AppData\\Local\\Temp'))
            .toBe('C:\\Users\\me\\AppData\\Local\\Temp\\nexus_mcp_code.json');
        // A trailing separator on the temp dir must not double up.
        expect(vaultNotePath(socket, 'win32', 'C:\\Temp\\'))
            .toBe('C:\\Temp\\nexus_mcp_code.json');
    });
});

describe('Nexus vault note parsing', () => {
    it('accepts exactly the published shape', () => {
        expect(parseVaultNote('{"vaultName":"code","basePath":"/Users/me/Code"}'))
            .toEqual({ vaultName: 'code', basePath: '/Users/me/Code' });
    });

    it.each([
        ['not json', '{nope'],
        ['a bare string', '"/Users/me/Code"'],
        ['null', 'null'],
        ['missing basePath', '{"vaultName":"code"}'],
        ['empty basePath', '{"vaultName":"code","basePath":""}'],
        ['non-string basePath', '{"vaultName":"code","basePath":42}'],
    ])('ignores %s', (_label, raw) => {
        expect(parseVaultNote(raw)).toBeUndefined();
    });
});

describe('Nexus vault notes beside live sockets', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'nexus-vault-notes-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('attaches basePath from a readable note and leaves it unset for a missing or corrupt one', () => {
        const withNote = { name: 'code', path: join(dir, 'nexus_mcp_code.sock') };
        const corrupt = { name: 'notes', path: join(dir, 'nexus_mcp_notes.sock') };
        const missing = { name: 'work', path: join(dir, 'nexus_mcp_work.sock') };
        writeFileSync(join(dir, 'nexus_mcp_code.json'), JSON.stringify({ vaultName: 'code', basePath: dir }));
        writeFileSync(join(dir, 'nexus_mcp_notes.json'), '{not json');

        const entries = readVaultNotes([withNote, corrupt, missing], 'darwin');

        expect(entries).toHaveLength(3);
        expect(entries[0]).toMatchObject({ name: 'code', path: withNote.path });
        expect(entries[0].basePath).toBeDefined();
        expect(entries[1]).toEqual({ ...corrupt });
        expect(entries[2]).toEqual({ ...missing });
    });

    it('never surfaces a note that has no live socket behind it', () => {
        // The plugin for `orphan` is gone; only its note remains.
        writeFileSync(join(dir, 'nexus_mcp_orphan.json'), JSON.stringify({ vaultName: 'orphan', basePath: dir }));
        const live = { name: 'code', path: join(dir, 'nexus_mcp_code.sock') };

        const entries = readVaultNotes([live], 'darwin');

        expect(entries.map((entry) => entry.name)).toEqual(['code']);
    });
});

describe('Nexus vault selection by working directory', () => {
    const code: VaultEntry = { name: 'code', path: '/tmp/nexus_mcp_code.sock', basePath: '/Users/me/Code' };
    const nested: VaultEntry = {
        name: 'plugin',
        path: '/tmp/nexus_mcp_plugin.sock',
        basePath: '/Users/me/Code/.obsidian/plugins/nexus',
    };
    const notes: VaultEntry = { name: 'notes', path: '/tmp/nexus_mcp_notes.sock', basePath: '/Users/me/Notes' };
    const silent: VaultEntry = { name: 'mobile', path: '/tmp/nexus_mcp_mobile.sock' };

    it('picks the vault whose folder contains the cwd', () => {
        expect(resolveVaultByCwd('/Users/me/Code/src', [notes, code, silent], 'darwin')).toBe(code);
    });

    it('matches the vault folder itself, not only its children', () => {
        expect(resolveVaultByCwd('/Users/me/Code', [notes, code], 'darwin')).toBe(code);
        expect(resolveVaultByCwd('/Users/me/Code/', [notes, code], 'darwin')).toBe(code);
    });

    it('prefers the innermost vault when folders nest, whatever the order', () => {
        const cwd = '/Users/me/Code/.obsidian/plugins/nexus/src';
        expect(resolveVaultByCwd(cwd, [code, nested], 'darwin')).toBe(nested);
        expect(resolveVaultByCwd(cwd, [nested, code], 'darwin')).toBe(nested);
        // Above the nested vault but inside the outer one: the outer wins.
        expect(resolveVaultByCwd('/Users/me/Code/docs', [nested, code], 'darwin')).toBe(code);
    });

    it('returns undefined when no vault folder contains the cwd', () => {
        expect(resolveVaultByCwd('/Users/me/Elsewhere', [notes, code, silent], 'darwin')).toBeUndefined();
        expect(resolveVaultByCwd('/Users/me/Code', [silent], 'darwin')).toBeUndefined();
        expect(resolveVaultByCwd('/Users/me/Code', [], 'darwin')).toBeUndefined();
    });

    it('is separator-aware: /x/Code does not claim /x/CodeOther', () => {
        expect(resolveVaultByCwd('/Users/me/CodeOther', [code], 'darwin')).toBeUndefined();
        expect(resolveVaultByCwd('/Users/me/CodeOther/src', [code], 'darwin')).toBeUndefined();
    });

    it('normalises redundant path segments before comparing', () => {
        expect(resolveVaultByCwd('/Users/me/Notes/../Code/./src', [notes, code], 'darwin')).toBe(code);
    });

    it('compares Windows paths with Windows rules: backslashes and case-insensitive', () => {
        const winVault: VaultEntry = {
            name: 'code',
            path: '\\\\.\\pipe\\nexus_mcp_code',
            basePath: 'C:\\Users\\Me\\Code',
        };
        expect(resolveVaultByCwd('c:\\users\\me\\code\\src', [winVault], 'win32')).toBe(winVault);
        expect(resolveVaultByCwd('C:\\Users\\Me\\CodeOther', [winVault], 'win32')).toBeUndefined();
    });
});
