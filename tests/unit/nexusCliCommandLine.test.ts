import {
    partitionUseArgv,
    resolveUseCommand,
    serializeToolArgv,
} from '../../cli/commandLine';
import { tokenizeWithMeta } from '../../src/agents/toolManager/services/ToolCliNormalizer';

describe('Nexus CLI structured use argv', () => {
    it('separates top-level context from the tool command at --', () => {
        const result = partitionUseArgv([
            'use',
            '--memory', 'Resuming research.',
            '--goal', 'Load the workspace.',
            '--',
            'memory', 'load-workspace', '--workspace', 'NeuroAI Mapping', '--limit', '1',
        ]);

        expect(result.outerArgv).toEqual([
            'use',
            '--memory', 'Resuming research.',
            '--goal', 'Load the workspace.',
        ]);
        expect(result.toolArgv).toEqual([
            'memory', 'load-workspace', '--workspace', 'NeuroAI Mapping', '--limit', '1',
        ]);
    });

    it('serializes shell-preserved values for the existing Nexus tokenizer', () => {
        const argv = [
            'memory',
            'create-state',
            '--name',
            'The Borrowed Brain reorientation',
            '--conversation-context',
            'He said "map A, then B".\nNext line.',
            '--active-task',
            'Review C:\\Research',
        ];

        const command = serializeToolArgv(argv);
        expect(tokenizeWithMeta(command).map((token) => token.value)).toEqual(argv);
    });

    it('reconstructs the reported multiword workspace command', () => {
        expect(resolveUseCommand(
            ['use'],
            ['memory', 'load-workspace', '--workspace', 'NeuroAI Mapping', '--limit', '1']
        )).toBe('memory load-workspace --workspace "NeuroAI Mapping" --limit 1');
    });

    it('keeps the legacy one-string form for compatibility', () => {
        expect(resolveUseCommand(
            ['use', 'content read --path Notes/Test.md --start-line 1'],
            null
        )).toBe('content read --path Notes/Test.md --start-line 1');
    });

    it('rejects PowerShell-fragmented legacy commands with an actionable correction', () => {
        expect(() => resolveUseCommand([
            'use',
            'memory load-workspace --workspace NeuroAI',
            'Mapping --limit 1',
        ], null)).toThrow(/PowerShell may have consumed nested double quotes.*structured form/);
    });

    it('rejects missing or misplaced structured command arguments', () => {
        expect(() => resolveUseCommand(['use'], [])).toThrow(/needs an agent and command/);
        expect(() => resolveUseCommand(['use', 'memory'], ['load-workspace']))
            .toThrow(/put context flags before `--`/);
    });

    it('does not treat -- as a delimiter for other verbs', () => {
        expect(partitionUseArgv(['tools', '--', 'memory'])).toEqual({
            outerArgv: ['tools', '--', 'memory'],
            toolArgv: null,
        });
    });
});
