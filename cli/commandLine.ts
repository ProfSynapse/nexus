/**
 * Pure command-line helpers for the standalone Nexus CLI.
 *
 * Design rule (mirrors docs/plans/cli-parser-edge-cases-plan.md for the
 * server-side parser): **loud failure beats silent corruption.** The primary
 * caller is an AI agent that cannot see the shell, so every malformed
 * invocation must produce an error that names the mistake and shows the
 * corrected command — never a silently truncated request that reaches the
 * vault as a different tool call than the one intended.
 */

/** Context flags that take a value. Declaring them removes all value-vs-verb guessing. */
export const CONTEXT_VALUE_FLAGS = new Set([
    'memory', 'goal', 'workspace', 'session', 'constraints', 'operation-id', 'vault',
]);

/** Context flags that never take a value. */
export const CONTEXT_BOOLEAN_FLAGS = new Set(['json', 'dry-run', 'help']);

/**
 * Transport-flag pattern: `--<flag>-stdin` / `--<flag>-file` for ANY tool flag,
 * so multiline payloads (create-state's --conversation-context, prompt bodies,
 * task descriptions — not just content write's --content) can stay out of shell
 * argv. Collision-safe today: no shipped tool flag ends in `-stdin` or `-file`
 * (guarded by shippedGuidanceCommands.test.ts).
 */
const TRANSPORT_FLAG_RE = /^([a-z0-9][a-z0-9-]*)-(stdin|file)$/;

export interface TransportFlag {
    /** The bare tool flag the transport stands in for (no leading `--`). */
    base: string;
    kind: 'stdin' | 'file';
}

/**
 * Parse a `--<flag>-stdin` / `--<flag>-file` token. Returns null for anything
 * that is not a transport flag. Single source for the transport syntax —
 * consumed by the hydrator below and by shippedGuidanceCommands.test.ts.
 */
export function parseTransportFlag(token: string): TransportFlag | null {
    if (!token.startsWith('--')) return null;
    const match = TRANSPORT_FLAG_RE.exec(token.slice(2));
    return match ? { base: match[1], kind: match[2] as 'stdin' | 'file' } : null;
}

/** True when a flag key (no leading `--`) is a CLI-only content transport. */
export function isTransportFlagKey(key: string): boolean {
    return TRANSPORT_FLAG_RE.test(key);
}

/**
 * Context flags that are never also a tool flag, so finding one after `--`
 * is unambiguously a misplacement worth steering on.
 *
 * `--workspace` is deliberately EXCLUDED: `memory load-workspace --workspace X`
 * is legitimate tool syntax. It is the only such collision across all 66 tools.
 */
export const MISPLACEABLE_CONTEXT_FLAGS = new Set([
    'memory', 'goal', 'constraints', 'operation-id', 'vault', 'session', 'json', 'dry-run',
]);

export const VERBS = ['tools', 'use', 'playbook', 'vaults', 'doctor', 'help'];

export interface PartitionedUseArgv {
    outerArgv: string[];
    toolArgv: string[] | null;
}

export interface ParsedArgs {
    positionals: string[];
    flags: Record<string, string | boolean>;
}

export interface ToolContentReaders {
    readStdin: () => string;
    readFile: (path: string) => string;
}

/** Levenshtein distance, capped for short flag names. */
function editDistance(a: string, b: string): number {
    const rows = Array.from({ length: a.length + 1 }, (_, i) => {
        const row = new Array<number>(b.length + 1).fill(0);
        row[0] = i;
        return row;
    });
    for (let j = 0; j <= b.length; j++) rows[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            rows[i][j] = Math.min(
                rows[i - 1][j] + 1,
                rows[i][j - 1] + 1,
                rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
    }
    return rows[a.length][b.length];
}

/** Strip case and separators so `--workspaceId` can match `--workspace`. */
function normalizeFlagKey(key: string): string {
    return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Suggest the intended context flag for an unrecognized one. Catches the two
 * mistakes agents actually make: camelCase (`--workspaceId`, `--dryRun`) and
 * near-miss typos (`--memmory`, `--vualt`).
 */
export function suggestContextFlag(key: string): string | undefined {
    const known = [...CONTEXT_VALUE_FLAGS, ...CONTEXT_BOOLEAN_FLAGS];
    const target = normalizeFlagKey(key);
    let best: string | undefined;
    let bestScore = Infinity;
    for (const candidate of known) {
        const score = editDistance(target, normalizeFlagKey(candidate));
        if (score < bestScore) {
            bestScore = score;
            best = candidate;
        }
    }
    // 2 edits covers `workspaceid`→`workspace` and `memmory`→`memory` without
    // matching genuinely unrelated tool flags like `--new-path`.
    return bestScore <= 2 ? best : undefined;
}

/**
 * Locate the first token that is a positional (a verb candidate) rather than a
 * flag or a flag's value.
 *
 * Unknown flags are treated as value-taking when the next token isn't itself a
 * flag — matching the historical parse behavior. This maximizes the chance of
 * still identifying `use` when a flag is misspelled, so the caller gets the
 * precise "unknown flag" error instead of a confusing downstream one.
 */
export function findVerb(argv: string[]): string | undefined {
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === '--') return undefined;
        if (token.startsWith('--')) {
            const key = token.slice(2);
            const next = argv[i + 1];
            const takesValue = CONTEXT_BOOLEAN_FLAGS.has(key)
                ? false
                : next !== undefined && !next.startsWith('--');
            if (takesValue) i++;
            continue;
        }
        return token;
    }
    return undefined;
}

/**
 * Split `nexus use [context] -- [tool argv]` before generic flag parsing.
 *
 * The verb is located by scanning rather than assumed at argv[0], so context
 * flags may precede the verb (`nexus --vault V use ... -- storage list`). That
 * ordering already works for every other verb, and silently corrupted the
 * request for `use` before this scan existed.
 */
export function partitionUseArgv(argv: string[]): PartitionedUseArgv {
    const delimiterIndex = argv.indexOf('--');
    if (delimiterIndex < 0) return { outerArgv: argv, toolArgv: null };
    const outerArgv = argv.slice(0, delimiterIndex);
    if (findVerb(outerArgv) !== 'use') return { outerArgv: argv, toolArgv: null };
    return { outerArgv, toolArgv: argv.slice(delimiterIndex + 1) };
}

/**
 * Parse context flags and positionals, rejecting anything ambiguous.
 *
 * Every rejection here replaces a former silent misparse. In particular a bare
 * `--` used to produce a `flags['']` entry that swallowed the following token —
 * the mechanism that turned a misordered `use` into a truncated tool call.
 */
export function parseOuterArgs(argv: string[]): ParsedArgs {
    const positionals: string[] = [];
    const flags: Record<string, string | boolean> = {};

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];

        if (token === '--') {
            // Reaching here means the delimiter was not claimed by `use`. Name the
            // actual cause — a missing or misspelled verb — rather than the symptom.
            const verb = positionals[0];
            if (verb === undefined) {
                throw new Error(
                    'No command before the `--` delimiter. The delimiter belongs to `use`: ' +
                    'nexus use --memory "..." --goal "..." -- <agent command>'
                );
            }
            if (verb !== 'use') {
                const suggestion = suggestVerb(verb);
                throw new Error(
                    `\`--\` is the delimiter for \`nexus use\`, but the command here is "${verb}".` +
                    (suggestion === 'use'
                        ? ' Did you mean `nexus use`?'
                        : ` \`${verb}\` takes no tool command; drop the \`--\`.`) +
                    ' Write: nexus use --memory "..." --goal "..." -- <agent command>'
                );
            }
            throw new Error(
                'Stray `--`: `use` already consumed its delimiter, so this is a second one. ' +
                'Use exactly one: context flags before it, one complete tool command after it.'
            );
        }

        if (!token.startsWith('--')) {
            positionals.push(token);
            continue;
        }

        const key = token.slice(2);

        if (key === '') {
            throw new Error(`Invalid flag "${token}". Context flags look like --memory "...".`);
        }

        if (isTransportFlagKey(key)) {
            throw new Error(
                `--${key} is a tool-command flag, so it belongs AFTER the \`--\` delimiter: ` +
                `nexus use --memory "..." --goal "..." -- content write --path Note.md --${key}${key.endsWith('-file') ? ' note.md' : ''}`
            );
        }

        if (!CONTEXT_VALUE_FLAGS.has(key) && !CONTEXT_BOOLEAN_FLAGS.has(key)) {
            const suggestion = suggestContextFlag(key);
            throw new Error(
                `Unknown context flag "--${key}".` +
                (suggestion ? ` Did you mean "--${suggestion}"?` : '') +
                ' Context flags are: ' + [...CONTEXT_VALUE_FLAGS, ...CONTEXT_BOOLEAN_FLAGS].map((f) => `--${f}`).join(', ') +
                '. Tool flags (like --path) go after the `--` delimiter.'
            );
        }

        if (Object.prototype.hasOwnProperty.call(flags, key)) {
            throw new Error(
                `--${key} was given twice. Pass it once; a repeated flag silently discarded the earlier value.`
            );
        }

        if (CONTEXT_BOOLEAN_FLAGS.has(key)) {
            flags[key] = true;
            continue;
        }

        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            throw new Error(
                `--${key} requires a value` +
                (next === undefined ? ' but reached the end of the command.' : `, but the next token is the flag "${next}".`)
            );
        }
        flags[key] = next;
        i++;
    }

    return { positionals, flags };
}

function quoteToolToken(value: string): string {
    // Bare tokens keep boolean/number/flag semantics in ToolCliNormalizer.
    // Everything else is double-quoted and escaped for its tokenizer.
    if (/^[A-Za-z0-9_./:@%+=-]+$/.test(value)) return value;
    const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
    return `"${escaped}"`;
}

/**
 * Reject context flags that ended up after `--`, where they would be sent to
 * the tool (and rejected as unknown) instead of scoping the call.
 *
 * `--workspace` is not checked here: it is genuinely a tool flag on
 * `memory load-workspace`, so its presence after `--` is legitimate.
 */
function assertNoMisplacedContextFlags(toolArgv: string[]): void {
    for (const token of toolArgv) {
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        if (!MISPLACEABLE_CONTEXT_FLAGS.has(key)) continue;
        throw new Error(
            `--${key} is a context flag, so it belongs BEFORE the \`--\` delimiter, not in the tool command. ` +
            `Write: nexus use --${key} "..." ... -- <agent command>`
        );
    }
}

/**
 * Reject a second `--` sitting where an agent or tool name belongs.
 *
 * A bare `--` that directly follows a flag is plausibly that flag's value
 * (`--content --`), so it is left alone; anywhere else it is a duplicated
 * delimiter, which would otherwise reach the tokenizer as an empty-named flag.
 */
function assertNoStrayDelimiter(toolArgv: string[]): void {
    for (let i = 0; i < toolArgv.length; i++) {
        if (toolArgv[i] !== '--') continue;
        const previous = i > 0 ? toolArgv[i - 1] : undefined;
        if (previous !== undefined && previous.startsWith('--')) continue;
        throw new Error(
            'Found a second `--` inside the tool command. Use exactly one delimiter: ' +
            'context flags before it, one complete tool command after it.'
        );
    }
}

/** Rebuild a lossless ToolCliNormalizer command from shell-preserved argv. */
export function serializeToolArgv(toolArgv: string[]): string {
    assertNoMisplacedContextFlags(toolArgv);
    assertNoStrayDelimiter(toolArgv);

    if (toolArgv.length === 0) {
        throw new Error(
            'Nothing after `--`. Add the tool command: nexus use --memory "..." --goal "..." -- storage list'
        );
    }

    // An agent that quotes the whole command after the delimiter
    // (`-- "storage list"`) produced one token instead of two. That is
    // unambiguous, so accept it rather than failing on a formatting nit.
    if (toolArgv.length === 1) {
        const only = toolArgv[0];
        if (/\s/.test(only.trim())) return only.trim();
        throw new Error(
            `Structured \`use\` needs an agent and command after \`--\`, got only "${only}". ` +
            `Write: -- ${only} <tool-name> (run \`nexus tools ${only}\` to list its tools).`
        );
    }

    return toolArgv.map(quoteToolToken).join(' ');
}

/**
 * Replace CLI-only transport flags (`--<flag>-stdin`, `--<flag>-file <path>`)
 * with the normal tool flag they stand in for. This keeps large/multiline
 * payloads out of shell argv, where Windows `.cmd` wrappers and nested quote
 * parsing can otherwise alter them.
 *
 * Works for ANY value-taking tool flag, not just `--content`:
 *   --content-stdin                → --content <stdin>
 *   --conversation-context-file f  → --conversation-context <contents of f>
 *
 * Rules: at most one `-stdin` transport per command (standard input can only be
 * read once); several `-file` transports may coexist; a flag may not be given
 * both directly and via a transport.
 */
export function hydrateToolContentArgv(toolArgv: string[], readers: ToolContentReaders): string[] {
    const transports: Array<TransportFlag & { index: number }> = [];

    toolArgv.forEach((token, index) => {
        const transport = parseTransportFlag(token);
        if (transport) transports.push({ ...transport, index });
    });

    if (transports.length === 0) return toolArgv;

    const stdinTransports = transports.filter((t) => t.kind === 'stdin');
    if (stdinTransports.length > 1) {
        throw new Error(
            'Use exactly one --<flag>-stdin transport per command — standard input can only be read once. ' +
            'Move the other values to --<flag>-file <path> or pass them inline.'
        );
    }

    const seenBases = new Set<string>();
    for (const transport of transports) {
        if (seenBases.has(transport.base)) {
            throw new Error(`Use exactly one of --${transport.base}-stdin or --${transport.base}-file.`);
        }
        seenBases.add(transport.base);
        if (toolArgv.includes(`--${transport.base}`)) {
            throw new Error(
                `Do not combine --${transport.base} with --${transport.base}-stdin or --${transport.base}-file.`
            );
        }
    }

    const hydrated: string[] = [];
    for (let index = 0; index < toolArgv.length; index++) {
        const transport = transports.find((t) => t.index === index);
        if (!transport) {
            hydrated.push(toolArgv[index]);
            continue;
        }
        if (transport.kind === 'stdin') {
            hydrated.push(`--${transport.base}`, readers.readStdin());
            continue;
        }
        const path = toolArgv[index + 1];
        if (path === undefined || path.startsWith('--')) {
            throw new Error(`--${transport.base}-file requires a local file path.`);
        }
        hydrated.push(`--${transport.base}`, readers.readFile(path));
        index++;
    }
    return hydrated;
}

/**
 * Explain a legacy `use` whose tool command arrived as several argv entries.
 *
 * Two distinct causes, distinguished by whether any fragment contains
 * whitespace: a quoted command string that the shell tore apart (fragments keep
 * their internal spaces), versus a command written without the `--` delimiter
 * at all (every fragment is a single bare word). Blaming PowerShell for the
 * latter — as this used to, unconditionally — sends callers hunting a quoting
 * bug that does not exist.
 */
function describeFragmentedLegacyCommand(extras: string[], isWindows: boolean): string {
    const rebuilt = extras.join(' ');
    const looksFragmented = extras.some((part) => /\s/.test(part));

    if (!looksFragmented) {
        return (
            'The tool command needs a `--` delimiter before it. ' +
            `Write: nexus use --memory "..." --goal "..." -- ${rebuilt}`
        );
    }

    return (
        'The quoted tool command was split into several shell arguments' +
        (isWindows ? ' (PowerShell can consume nested double quotes)' : '') +
        '. Use the delimiter form so no nested quoting is needed: ' +
        `nexus use --memory "..." --goal "..." -- ${rebuilt}`
    );
}

export interface ResolveUseOptions {
    /** Platform hint; only affects error wording. Defaults to the host platform. */
    isWindows?: boolean;
}

/** Resolve either canonical structured argv or the legacy one-string form. */
export function resolveUseCommand(
    positionals: string[],
    toolArgv: string[] | null,
    options: ResolveUseOptions = {}
): string {
    const isWindows = options.isWindows ?? process.platform === 'win32';

    if (toolArgv !== null) {
        if (positionals.length !== 1 || positionals[0] !== 'use') {
            const extras = positionals.filter((value) => value !== 'use');
            throw new Error(
                'With structured `use`, put context flags before `--` and the complete tool command after it. ' +
                (extras.length
                    ? `Unexpected before the delimiter: ${extras.map((value) => `"${value}"`).join(', ')}.`
                    : 'The `use` verb must appear before the delimiter.')
            );
        }
        return serializeToolArgv(toolArgv);
    }

    if (positionals.length < 2) {
        throw new Error(
            '`use` needs a tool command. Write: nexus use --memory "..." --goal "..." -- <agent command>, ' +
            'e.g. -- storage list'
        );
    }

    if (positionals.length > 2) {
        throw new Error(describeFragmentedLegacyCommand(positionals.slice(1), isWindows));
    }

    const command = positionals[1];
    // A lone bare word is a tool name without its agent (or an agent without its
    // tool). The server can only reply "Invalid command", which does not say why.
    if (!/\s/.test(command.trim())) {
        throw new Error(
            `"${command}" is not a complete tool command — it needs an agent AND a tool name, ` +
            `e.g. "storage list". Write: nexus use --memory "..." --goal "..." -- <agent> <tool>. ` +
            'Run `nexus tools` to see the catalog.'
        );
    }
    return command.trim();
}

/** Suggest the intended verb for an unrecognized one. */
export function suggestVerb(candidate: string): string | undefined {
    const target = normalizeFlagKey(candidate);
    let best: string | undefined;
    let bestScore = Infinity;
    for (const verb of VERBS) {
        const score = editDistance(target, normalizeFlagKey(verb));
        if (score < bestScore) {
            bestScore = score;
            best = verb;
        }
    }
    return bestScore <= 2 ? best : undefined;
}
