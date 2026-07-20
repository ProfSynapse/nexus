/** Pure command-line helpers for the standalone Nexus CLI. */

export interface PartitionedUseArgv {
    outerArgv: string[];
    toolArgv: string[] | null;
}

/**
 * Split `nexus use [context] -- [tool argv]` before generic flag parsing.
 * The delimiter is meaningful only for `use`; other verbs retain their
 * existing argv behavior.
 */
export function partitionUseArgv(argv: string[]): PartitionedUseArgv {
    if (argv[0] !== 'use') return { outerArgv: argv, toolArgv: null };
    const delimiterIndex = argv.indexOf('--', 1);
    if (delimiterIndex < 0) return { outerArgv: argv, toolArgv: null };
    return {
        outerArgv: argv.slice(0, delimiterIndex),
        toolArgv: argv.slice(delimiterIndex + 1),
    };
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

/** Rebuild a lossless ToolCliNormalizer command from shell-preserved argv. */
export function serializeToolArgv(toolArgv: string[]): string {
    if (toolArgv.length < 2) {
        throw new Error('Structured `use` needs an agent and command after `--`.');
    }
    return toolArgv.map(quoteToolToken).join(' ');
}

/** Resolve either canonical structured argv or the legacy one-string form. */
export function resolveUseCommand(positionals: string[], toolArgv: string[] | null): string {
    if (toolArgv !== null) {
        if (positionals.length !== 1 || positionals[0] !== 'use') {
            throw new Error('With structured `use`, put context flags before `--` and the complete tool command after it.');
        }
        return serializeToolArgv(toolArgv);
    }

    if (positionals.length < 2) {
        throw new Error('`use` needs a tool command after `--`.');
    }
    if (positionals.length > 2) {
        throw new Error(
            'The legacy tool command arrived as multiple shell arguments. ' +
            'PowerShell may have consumed nested double quotes. Use the structured form: ' +
            'nexus use --memory "..." --goal "..." -- memory load-workspace --workspace "NeuroAI Mapping".'
        );
    }
    return positionals[1];
}
