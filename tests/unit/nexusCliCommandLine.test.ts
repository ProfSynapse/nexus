import {
    hydrateToolContentArgv,
    parseOuterArgs,
    partitionUseArgv,
    resolveUseCommand,
    serializeToolArgv,
    suggestVerb,
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

    it('hydrates a transport for any tool flag, not just --content', () => {
        const context = '## Original Request\nUser said "map A, then B".\n\n## Status\nIn progress.';
        const argv = hydrateToolContentArgv(
            [
                'memory', 'create-state',
                '--name', 'refactor checkpoint',
                '--conversation-context-stdin',
                '--active-task', 'refactor',
                '--active-files', 'a.ts',
                '--next-steps', 'run tests',
            ],
            { readStdin: () => context, readFile: () => '' }
        );

        expect(argv).toEqual([
            'memory', 'create-state',
            '--name', 'refactor checkpoint',
            '--conversation-context', context,
            '--active-task', 'refactor',
            '--active-files', 'a.ts',
            '--next-steps', 'run tests',
        ]);
        // The hydrated value must survive serialization + server tokenization intact.
        expect(tokenizeWithMeta(serializeToolArgv(argv)).map((token) => token.value)).toEqual(argv);
    });

    it('allows several -file transports for different flags in one command', () => {
        const readFile = jest.fn((path: string) => `<${path}>`);
        const argv = hydrateToolContentArgv(
            ['memory', 'create-state', '--conversation-context-file', 'ctx.md', '--active-task-file', 'task.md'],
            { readStdin: () => '', readFile }
        );

        expect(argv).toEqual([
            'memory', 'create-state',
            '--conversation-context', '<ctx.md>',
            '--active-task', '<task.md>',
        ]);
        expect(readFile).toHaveBeenCalledTimes(2);
    });

    it('rejects conflicting generic transports', () => {
        const readers = { readStdin: () => 'stdin', readFile: () => 'file' };

        // Two stdin transports — stdin can only be read once.
        expect(() => hydrateToolContentArgv([
            'memory', 'create-state', '--conversation-context-stdin', '--active-task-stdin',
        ], readers)).toThrow(/one --<flag>-stdin/);
        // Same flag both directly and via transport.
        expect(() => hydrateToolContentArgv([
            'memory', 'create-state', '--conversation-context', 'inline', '--conversation-context-file', 'ctx.md',
        ], readers)).toThrow(/Do not combine --conversation-context/);
        // Same flag via two transports.
        expect(() => hydrateToolContentArgv([
            'memory', 'create-state', '--conversation-context-stdin', '--conversation-context-file', 'ctx.md',
        ], readers)).toThrow(/exactly one of --conversation-context-stdin or --conversation-context-file/);
        // -file without a path.
        expect(() => hydrateToolContentArgv([
            'memory', 'create-state', '--conversation-context-file', '--name', 'x',
        ], readers)).toThrow(/--conversation-context-file requires a local file path/);
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

    it('blames quote fragmentation only when a fragment actually kept its spaces', () => {
        // Fragments retain internal whitespace -> a quoted string really was torn apart.
        const fragmented = ['use', 'memory load-workspace --workspace NeuroAI', 'Mapping --limit 1'];
        expect(() => resolveUseCommand(fragmented, null, { isWindows: true }))
            .toThrow(/PowerShell can consume nested double quotes/);
        expect(() => resolveUseCommand(fragmented, null, { isWindows: false }))
            .toThrow(/split into several shell arguments/);
        // The misleading PowerShell blame must not reach a POSIX caller.
        expect(() => resolveUseCommand(fragmented, null, { isWindows: false }))
            .not.toThrow(/PowerShell/);
    });

    it('tells a caller who omitted the delimiter to add it, rebuilt from what they typed', () => {
        // Every fragment is a bare word -> nothing was fragmented; `--` is just missing.
        expect(() => resolveUseCommand(['use', 'storage', 'list'], null, { isWindows: false }))
            .toThrow(/needs a `--` delimiter before it.*-- storage list/s);
        expect(() => resolveUseCommand(['use', 'storage', 'list'], null, { isWindows: true }))
            .not.toThrow(/PowerShell/);
    });

    it('rejects missing or misplaced structured command arguments', () => {
        expect(() => resolveUseCommand(['use'], [])).toThrow(/Nothing after `--`/);
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

/**
 * Regression suite for the reported failure: context flags placed BEFORE the
 * `use` verb defeated delimiter detection, so the whole command fell through to
 * the legacy one-string path. A bare `--` then landed in the generic flag
 * parser, which stored the AGENT NAME under an empty-string key and skipped it —
 * sending a truncated tool name to the vault.
 *
 * That ordering already worked for `tools`, `vaults`, and `doctor`, so callers
 * reasonably generalized it to `use`, where it silently corrupted the request.
 */
describe('Nexus CLI argv ordering (flags before the verb)', () => {
    /** Full pipeline: exactly what main() does to build the request. */
    function buildRequest(argv: string[]): { tool: string; workspaceId: string; vault?: string } {
        const { outerArgv, toolArgv } = partitionUseArgv(argv);
        const { positionals, flags } = parseOuterArgs(outerArgv);
        return {
            tool: resolveUseCommand(positionals, toolArgv, { isWindows: false }),
            workspaceId: typeof flags.workspace === 'string' ? flags.workspace : 'default',
            vault: typeof flags.vault === 'string' ? flags.vault : undefined,
        };
    }

    const orderings: Array<[string, string[]]> = [
        ['flags after the verb', ['use', '--vault', 'My Vault', '--memory', 'm', '--goal', 'g']],
        ['flags before the verb', ['--vault', 'My Vault', 'use', '--memory', 'm', '--goal', 'g']],
        ['flags on both sides', ['--vault', 'My Vault', 'use', '--memory', 'm', '--goal', 'g']],
    ];

    describe.each(orderings)('with %s', (_label, prefix) => {
        it('keeps the agent name attached to the tool name', () => {
            // Previously sent tool:"list" — the agent name was swallowed.
            expect(buildRequest([...prefix, '--', 'storage', 'list']).tool).toBe('storage list');
        });

        it('preserves a multiword positional argument', () => {
            // Previously threw the bogus "PowerShell fragmented it" error.
            expect(buildRequest([...prefix, '--', 'memory', 'load-workspace', 'Silicon Zone']).tool)
                .toBe('memory load-workspace "Silicon Zone"');
        });

        it('routes --workspace after the delimiter to the TOOL, not to context', () => {
            // Previously the context parser ate it: workspaceId became "Silicon Zone"
            // and the tool lost its required argument entirely.
            const request = buildRequest([...prefix, '--', 'memory', 'load-workspace', '--workspace', 'Silicon Zone']);
            expect(request.tool).toBe('memory load-workspace --workspace "Silicon Zone"');
            expect(request.workspaceId).toBe('default');
        });

        it('still routes --workspace before the delimiter to context', () => {
            const request = buildRequest([...prefix, '--workspace', 'Research', '--', 'storage', 'list']);
            expect(request.workspaceId).toBe('Research');
            expect(request.tool).toBe('storage list');
        });

        it('carries the vault selection through either ordering', () => {
            expect(buildRequest([...prefix, '--', 'storage', 'list']).vault).toBe('My Vault');
        });

        it('keeps flags with values intact after the delimiter', () => {
            expect(buildRequest([...prefix, '--', 'content', 'read', '--path', 'a b.md', '--start-line', '1']).tool)
                .toBe('content read --path "a b.md" --start-line 1');
        });
    });

    it('finds the verb past a boolean flag', () => {
        expect(buildRequest(['--json', '--vault', 'V', 'use', '--memory', 'm', '--goal', 'g', '--', 'storage', 'list']).tool)
            .toBe('storage list');
    });

    it('is not fooled by a flag whose value is literally "use"', () => {
        const request = buildRequest(['--vault', 'use', 'use', '--memory', 'm', '--goal', 'g', '--', 'storage', 'list']);
        expect(request.vault).toBe('use');
        expect(request.tool).toBe('storage list');
    });
});

describe('Nexus CLI context-flag parsing hardening', () => {
    it('never swallows a token into an empty-string flag key', () => {
        // The exact mechanism of the reported bug: a bare `--` reaching the flag
        // parser used to set flags[''] = 'storage' and skip the token.
        expect(() => parseOuterArgs(['use', '--memory', 'm', '--', 'storage', 'list']))
            .toThrow(/Stray `--`/);
    });

    it('names the real cause when -- follows a verb that has no delimiter', () => {
        expect(() => parseOuterArgs(['tools', '--', 'storage']))
            .toThrow(/the command here is "tools".*`tools` takes no tool command; drop the `--`/);
    });

    it('names a misspelled use verb rather than blaming the delimiter', () => {
        expect(() => parseOuterArgs(['uses', '--', 'storage', 'list']))
            .toThrow(/the command here is "uses".*Did you mean `nexus use`\?/);
    });

    it('reports a missing verb when -- comes before any command', () => {
        expect(() => parseOuterArgs(['--vault', 'V', '--', 'storage', 'list']))
            .toThrow(/No command before the `--` delimiter/);
    });

    it('rejects unknown context flags instead of ignoring them', () => {
        // Previously silent: a typo'd --vault produced a baffling "Multiple vaults open".
        expect(() => parseOuterArgs(['use', '--vualt', 'V'])).toThrow(/Unknown context flag "--vualt".*Did you mean "--vault"/);
    });

    it('maps camelCase context flags back to their kebab-case spelling', () => {
        expect(() => parseOuterArgs(['use', '--workspaceId', 'x'])).toThrow(/Did you mean "--workspace"/);
        expect(() => parseOuterArgs(['use', '--dryRun'])).toThrow(/Did you mean "--dry-run"/);
    });

    it('points misplaced tool flags at the delimiter rather than guessing', () => {
        expect(() => parseOuterArgs(['use', '--path', 'a.md']))
            .toThrow(/Tool flags \(like --path\) go after the `--` delimiter/);
    });

    it('explains that content transport flags belong after the delimiter', () => {
        expect(() => parseOuterArgs(['use', '--content-stdin']))
            .toThrow(/--content-stdin is a tool-command flag, so it belongs AFTER the `--` delimiter/);
    });

    it('rejects a repeated context flag instead of silently keeping the last', () => {
        expect(() => parseOuterArgs(['use', '--memory', 'first', '--memory', 'second']))
            .toThrow(/--memory was given twice/);
    });

    it('rejects a value flag whose value is missing or is another flag', () => {
        expect(() => parseOuterArgs(['use', '--memory'])).toThrow(/--memory requires a value but reached the end/);
        expect(() => parseOuterArgs(['use', '--memory', '--goal', 'g']))
            .toThrow(/--memory requires a value, but the next token is the flag "--goal"/);
    });

    it('accepts the full documented context flag set', () => {
        const { positionals, flags } = parseOuterArgs([
            '--vault', 'V', 'use',
            '--memory', 'm', '--goal', 'g', '--workspace', 'w',
            '--session', 's', '--constraints', 'c', '--json', '--dry-run',
        ]);
        expect(positionals).toEqual(['use']);
        expect(flags).toEqual({
            vault: 'V', memory: 'm', goal: 'g', workspace: 'w',
            session: 's', constraints: 'c', json: true, 'dry-run': true,
        });
    });

    it('suggests the intended verb for a near-miss', () => {
        expect(suggestVerb('tool')).toBe('tools');
        expect(suggestVerb('usee')).toBe('use');
        expect(suggestVerb('wildlyunrelated')).toBeUndefined();
    });
});

describe('Nexus CLI tool-command guardrails', () => {
    it('accepts a whole command quoted after the delimiter', () => {
        // An agent that writes `-- "storage list"` produced one token, not two.
        // Unambiguous, so it is accepted rather than failed on a formatting nit.
        expect(serializeToolArgv(['storage list'])).toBe('storage list');
        expect(serializeToolArgv(['memory load-workspace "Silicon Zone"']))
            .toBe('memory load-workspace "Silicon Zone"');
    });

    it('rejects a lone bare word as an incomplete command', () => {
        expect(() => serializeToolArgv(['storage']))
            .toThrow(/needs an agent and command after `--`, got only "storage"/);
    });

    it('rejects a bare tool name in the legacy form with a specific reason', () => {
        // The server can only answer "Invalid command", which does not say why.
        expect(() => resolveUseCommand(['use', 'list'], null))
            .toThrow(/not a complete tool command — it needs an agent AND a tool name/);
    });

    it('steers context flags that landed after the delimiter', () => {
        expect(() => serializeToolArgv(['storage', 'list', '--memory', 'x']))
            .toThrow(/--memory is a context flag, so it belongs BEFORE the `--` delimiter/);
        expect(() => serializeToolArgv(['storage', 'list', '--vault', 'V']))
            .toThrow(/--vault is a context flag/);
    });

    it('does NOT flag --workspace after the delimiter, which is real tool syntax', () => {
        // memory load-workspace takes --workspace; it is the only context/tool
        // flag collision across the catalog, so it must stay permitted.
        expect(serializeToolArgv(['memory', 'load-workspace', '--workspace', 'Silicon Zone']))
            .toBe('memory load-workspace --workspace "Silicon Zone"');
    });

    it('rejects a duplicated delimiter where an agent name belongs', () => {
        expect(() => serializeToolArgv(['--', 'storage', 'list']))
            .toThrow(/second `--` inside the tool command/);
    });

    it('allows a literal -- as a flag value', () => {
        expect(serializeToolArgv(['content', 'write', '--path', 'a.md', '--content', '--']))
            .toBe('content write --path a.md --content --');
    });
});
