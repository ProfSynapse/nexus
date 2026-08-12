/**
 * tests/unit/shippedGuidanceCommands.test.ts
 *
 * Validates every tool command we SHIP as guidance — `nexus --help`, the skill,
 * the playbooks (including their `tools:` frontmatter, which `nexus playbook`
 * feeds straight to getTools), and the CLI guide — against the generated tool
 * catalog in `cli-first-tool-schemas.json`.
 *
 * Why this exists: guidance IS the interface for an AI caller. A stale flag or
 * a renamed tool in an example is indistinguishable from a product bug on the
 * receiving end, and nothing else in the suite reads these files. The reported
 * `--workspace` confusion began exactly here — an error message and a dozen
 * examples teaching a shape that then broke.
 *
 * Two severities, deliberately separated:
 *   - unknown agent / tool / flag  -> always a defect; the doc names something
 *     that does not exist.
 *   - missing required argument    -> only checked for COMPLETE, copy-pasteable
 *     examples (a full `nexus use … -- <cmd>` line). Inline snippets such as
 *     `content set-property` legitimately name a tool without its arguments.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseTransportFlag } from '../../cli/commandLine';

const REPO_ROOT = path.join(__dirname, '..', '..');

interface CatalogArg {
    name: string;
    flag: string;
    type: string;
    required: boolean;
    positional: boolean;
}
interface CatalogTool { command: string; usage: string; arguments: CatalogArg[] }

// CLI-only transport flags (`--<flag>-stdin` / `--<flag>-file`) hydrate into
// `--<flag>` before the server parses; parseTransportFlag is the CLI's own
// parser for them, imported so this validator can never drift from it.

const catalog: { tools: CatalogTool[] } = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'cli-first-tool-schemas.json'), 'utf8')
);

const TOOLS = new Map<string, CatalogTool>();
const AGENTS = new Set<string>();
for (const tool of catalog.tools) {
    const [agent, name] = tool.command.split(/\s+/);
    AGENTS.add(agent);
    TOOLS.set(`${agent} ${name}`, tool);
}

function listMarkdown(dir: string, prefix: string): string[] {
    const abs = path.join(REPO_ROOT, dir);
    return fs.existsSync(abs)
        ? fs.readdirSync(abs).filter((f) => f.endsWith('.md')).map((f) => `${prefix}${f}`)
        : [];
}

function guidanceFiles(): string[] {
    const explicit = ['README.md', 'skill/SKILL.md', 'cli/nexus-cli.ts', 'cli/agents-snippet.md'];
    return [
        ...explicit,
        ...listMarkdown('skill/playbooks', 'skill/playbooks/'),
        ...listMarkdown('guide', 'guide/'),
    ].filter((rel) => fs.existsSync(path.join(REPO_ROOT, rel)));
}

/** Split like a POSIX shell would, so the doc's own quoting is what gets tested. */
function shellSplit(input: string): string[] | null {
    const tokens: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    let started = false;
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (quote) {
            if (ch === quote) quote = null;
            else current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
        if (/\s/.test(ch)) {
            if (current || started) { tokens.push(current); current = ''; started = false; }
            continue;
        }
        current += ch;
    }
    if (quote) return null;               // unterminated quote -> prose, not a command
    if (current || started) tokens.push(current);
    return tokens;
}

interface Sample { file: string; line: number; text: string; complete: boolean }

/** Mirrors ToolCliNormalizer's slug->CLI-name conversion. */
function toKebab(value: string): string {
    return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function stripTrailingNoise(value: string): string {
    return value.trim().replace(/[\\`,.]+$/, '').trim();
}

function extract(): { commands: Sample[]; selectors: Sample[] } {
    const commands: Sample[] = [];
    const selectors: Sample[] = [];

    for (const rel of guidanceFiles()) {
        const raw = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
        const joined = raw.replace(/\\\n\s*/g, ' ');   // fold shell line-continuations

        joined.split('\n').forEach((line, index) => {
            const delimited = /(?:^|\s)--\s+(.+?)\s*$/.exec(line);
            if (delimited && (/nexus use/.test(line) || /^\s*--\s/.test(line))) {
                const text = stripTrailingNoise(delimited[1]);
                if (text && AGENTS.has(text.split(/\s+/)[0])) {
                    commands.push({ file: rel, line: index + 1, text, complete: true });
                }
            }
        });

        for (const m of raw.matchAll(/`([a-z]+ [a-z][a-z-]*[^`\n]*)`/g)) {
            const text = stripTrailingNoise(m[1]);
            const words = text.split(/\s+/);
            if (words.length >= 2 && AGENTS.has(words[0])) {
                commands.push({ file: rel, line: raw.slice(0, m.index).split('\n').length, text, complete: false });
            }
        }

        const frontmatter = /^---\n([\s\S]*?)\n---/.exec(raw);
        const toolsList = frontmatter && /^tools:\s*\[([\s\S]*?)\]/m.exec(frontmatter[1]);
        if (toolsList) {
            for (const entry of toolsList[1].split(',')) {
                const text = entry.trim();
                if (text) selectors.push({ file: rel, line: 1, text, complete: false });
            }
        }
    }
    return { commands, selectors };
}

/** Returns human-readable problems with one documented command. */
function problems(sample: Sample): string[] {
    if (/[…]|\.\.\./.test(sample.text)) return [];        // elided prose
    const tokens = shellSplit(sample.text);
    if (!tokens || tokens.length < 2) return [];
    const [agent, toolName] = tokens;
    if (!AGENTS.has(agent)) return [];                     // not a command
    const spec = TOOLS.get(`${agent} ${toolName}`);
    if (!spec) {
        const available = catalog.tools
            .filter((t) => t.command.startsWith(`${agent} `))
            .map((t) => t.command.split(/\s+/)[1]).sort().join(', ');
        return [`unknown tool "${toolName}" for agent "${agent}". Available: ${available}`];
    }

    const byFlag = new Map(spec.arguments.map((a) => [a.flag, a]));
    const found: string[] = [];
    const satisfied = new Set<string>();

    for (let i = 2; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.startsWith('--') && token.length > 2) {
            const flagName = token.split('=')[0];
            const transport = parseTransportFlag(flagName);
            if (transport) {
                satisfied.add(`--${transport.base}`);
                // `--<flag>-file` consumes a path token; skip it like a flag value.
                if (transport.kind === 'file' && i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) i++;
                continue;
            }
            const base = flagName.startsWith('--no-') ? `--${flagName.slice(5)}` : flagName;
            const arg = byFlag.get(base);
            if (!arg) {
                found.push(`unknown flag "${flagName}" for ${spec.command}. Valid: ${[...byFlag.keys()].sort().join(' ')}`);
                continue;
            }
            satisfied.add(base);
            const hasInlineValue = token.includes('=');
            if (!hasInlineValue && arg.type !== 'boolean' && i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) i++;
        } else {
            const slot = spec.arguments.find((a) => a.positional && !satisfied.has(a.flag));
            if (slot) satisfied.add(slot.flag);
        }
    }

    if (sample.complete) {
        for (const arg of spec.arguments) {
            if (arg.required && !satisfied.has(arg.flag)) {
                found.push(`missing required "${arg.name}" (${arg.flag} or positional) for ${spec.command}`);
            }
        }
    }
    return found;
}

function report(samples: Sample[], check: (s: Sample) => string[]): string {
    const lines: string[] = [];
    for (const sample of samples) {
        for (const problem of check(sample)) {
            lines.push(`${sample.file}:${sample.line}\n    $ ${sample.text}\n    -> ${problem}`);
        }
    }
    return lines.join('\n\n');
}

describe('shipped guidance matches the tool catalog', () => {
    const { commands, selectors } = extract();

    it('found a meaningful corpus to check', () => {
        expect(commands.filter((c) => c.complete).length).toBeGreaterThan(15);
        expect(commands.length).toBeGreaterThan(40);
        expect(selectors.length).toBeGreaterThan(20);
    });

    it('every documented command uses a real agent, tool, and flags', () => {
        expect(report(commands, problems)).toBe('');
    });

    it('no tool flag collides with the CLI transport suffixes (-stdin/-file)', () => {
        // The CLI treats any `--<flag>-stdin` / `--<flag>-file` after `--` as a
        // content transport (cli/commandLine.ts). A real tool flag ending in one
        // of those suffixes would be hijacked and hydrated away before the server
        // saw it. Rename the tool argument if this ever fires.
        const colliding = catalog.tools.flatMap((tool) =>
            tool.arguments
                .filter((arg) => parseTransportFlag(arg.flag) !== null)
                .map((arg) => `${tool.command} ${arg.flag}`)
        );
        expect(colliding).toEqual([]);
    });

    it('every playbook `tools:` selector resolves to a real tool', () => {
        expect(report(selectors, (sample) => {
            const parts = sample.text.split(/\s+/);
            if (parts.length === 1) {
                return AGENTS.has(parts[0]) ? [] : [`unknown agent "${parts[0]}"`];
            }
            if (!TOOLS.has(`${parts[0]} ${parts[1]}`)) {
                return [AGENTS.has(parts[0])
                    ? `unknown tool "${parts[1]}" for agent "${parts[0]}"`
                    : `unknown agent "${parts[0]}"`];
            }
            return [];
        })).toBe('');
    });

    it('every tool named in the Apps table is a real registered slug', () => {
        // Apps are opt-in per vault, so an app the catalog snapshot did not have
        // enabled is still shippable. Validate against slugs declared in source
        // instead — that covers every app regardless of the snapshot vault.
        const declared = new Set<string>();
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.ts')) {
                    for (const m of fs.readFileSync(full, 'utf8').matchAll(/\bslug:\s*'([^']+)'/g)) {
                        declared.add(m[1]);
                        declared.add(toKebab(m[1]));
                    }
                }
            }
        };
        walk(path.join(REPO_ROOT, 'src', 'agents'));

        const appsPath = path.join(REPO_ROOT, 'guide', 'apps.md');
        if (!fs.existsSync(appsPath)) return;
        const failures: string[] = [];
        const lines = fs.readFileSync(appsPath, 'utf8').split('\n');
        lines.forEach((line, index) => {
            const cells = line.split('|').map((c) => c.trim());
            // Table body rows only: | **App** | tool, tool | description |
            if (cells.length < 5 || !/^\*\*/.test(cells[1])) return;
            for (const name of cells[2].split(',').map((n) => n.trim())) {
                if (!name || /\s/.test(name)) continue;
                if (!declared.has(name) && !declared.has(toKebab(name))) {
                    failures.push(`guide/apps.md:${index + 1} -> "${name}" (${cells[1]}) is not a registered tool slug`);
                }
            }
        });
        expect(failures.join('\n')).toBe('');
    });

    it('every relative doc link in shipped guidance resolves', () => {
        const failures: string[] = [];
        for (const rel of guidanceFiles()) {
            if (!rel.endsWith('.md')) continue;
            const raw = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
            for (const m of raw.matchAll(/\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g)) {
                const target = m[1];
                if (/^https?:/.test(target)) continue;
                const resolved = path.join(REPO_ROOT, path.dirname(rel), target);
                if (!fs.existsSync(resolved)) {
                    failures.push(`${rel}:${raw.slice(0, m.index).split('\n').length} -> broken link "${target}"`);
                }
            }
        }
        expect(failures.join('\n')).toBe('');
    });

    it('every embedded --prompts payload satisfies the executePrompts item contract', () => {
        // The CLI passes this JSON through verbatim, so a wrong field name here
        // reaches the provider as a silently malformed request rather than an error.
        const failures: string[] = [];
        for (const rel of guidanceFiles()) {
            const raw = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
            for (const m of raw.matchAll(/--prompts '(\[[^\n]*?\])'/g)) {
                let items: Array<Record<string, unknown>>;
                try {
                    items = JSON.parse(m[1]);
                } catch {
                    continue;   // elided illustrative payload (contains `…`)
                }
                const line = raw.slice(0, m.index).split('\n').length;
                for (const item of items) {
                    // `customPrompt` is the SYSTEM prompt; `prompt` is the user
                    // message. Both are needed — they are roles, not alternatives.
                    for (const required of ['type', 'prompt']) {
                        if (!(required in item)) failures.push(`${rel}:${line} -> prompt item missing required "${required}"`);
                    }
                    if (item.type === 'image' && !('savePath' in item)) {
                        failures.push(`${rel}:${line} -> image request missing required "savePath"`);
                    }
                }
            }
        }
        expect(failures.join('\n')).toBe('');
    });
});
