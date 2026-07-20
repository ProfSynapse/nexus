import { spawnSync } from 'node:child_process';
import { listVaultSockets, parseWindowsPipeListing } from '../../cli/vaultDiscovery';

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
