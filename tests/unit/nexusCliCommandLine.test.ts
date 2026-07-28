import {
    hydrateToolContentArgv,
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

    it('round-trips multiline Markdown with YAML quotes, spaces, and wikilinks', () => {
        const markdown = [
            '---',
            'owner: "[[Stakeholders/Ashlea Burke]]"',
            'reviewers: ["[[People/Joseph Rosenbaum]]", "[[People/Ada Lovelace]]"]',
            '---',
            '',
            '# Project update',
            'A multiline body with "embedded quotes" and spaces.',
        ].join('\n');
        const argv = ['content', 'write', '--path', 'Projects/Update.md', '--content', markdown];

        const command = serializeToolArgv(argv);

        expect(tokenizeWithMeta(command).map((token) => token.value)).toEqual(argv);
    });

    it('hydrates multiline content from stdin without putting it in shell argv', () => {
        const markdown = '---\nowner: "[[Stakeholders/Ashlea Burke]]"\n---\nBody';
        const argv = hydrateToolContentArgv(
            ['content', 'write', '--path', 'Projects/Update.md', '--content-stdin'],
            { readStdin: () => markdown, readFile: () => '' }
        );

        expect(argv).toEqual([
            'content', 'write', '--path', 'Projects/Update.md', '--content', markdown,
        ]);
        expect(tokenizeWithMeta(serializeToolArgv(argv)).map((token) => token.value)).toEqual(argv);
    });

    it('hydrates multiline content from a local file path containing spaces', () => {
        const markdown = '# Imported note\n\nContent with "quotes".';
        const readFile = jest.fn(() => markdown);

        const argv = hydrateToolContentArgv(
            ['content', 'write', '--content-file', 'C:\\Temp Files\\note.md', '--path', 'Imported.md'],
            { readStdin: () => '', readFile }
        );

        expect(readFile).toHaveBeenCalledWith('C:\\Temp Files\\note.md');
        expect(argv).toEqual([
            'content', 'write', '--content', markdown, '--path', 'Imported.md',
        ]);
    });

    it('rejects ambiguous or incomplete content transports', () => {
        const readers = { readStdin: () => 'stdin', readFile: () => 'file' };

        expect(() => hydrateToolContentArgv([
            'content', 'write', '--content', 'inline', '--content-stdin',
        ], readers)).toThrow(/Do not combine --content/);
        expect(() => hydrateToolContentArgv([
            'content', 'write', '--content-stdin', '--content-file', 'note.md',
        ], readers)).toThrow(/exactly one/);
        expect(() => hydrateToolContentArgv([
            'content', 'write', '--content-file', '--path', 'Note.md',
        ], readers)).toThrow(/requires a local file path/);
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
