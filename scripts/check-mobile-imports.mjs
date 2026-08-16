/**
 * Mobile init-crash gate.
 *
 * Nexus ships `isDesktopOnly: false`, so main.js runs on phones with no Node.js.
 * A *static* import executes during module init — before any `Platform.isDesktop`
 * check — so one top-level import of a Node built-in from a module that is
 * statically reachable from `src/main.ts` takes the plugin down at launch on every
 * phone, from a diff that looks unrelated. Nothing else in the toolchain catches
 * that: tsc is happy, esbuild is happy, and `obsidian dev:mobile on` cannot
 * reproduce it because Electron still resolves `require('fs')`.
 *
 * This file is the checker itself — the single implementation. It was a Python
 * script behind a launcher until 2026-08-15, when Obsidian's community scorecard
 * failed build verification: their builder is a clean container with Node and no
 * Python, so `npm run build` -> `npm run lint` -> `lint:mobile` exited 1 before
 * anything compiled, which also suppressed the malware, dependency, obfuscation
 * and network scans. A build gate may only depend on what the build already needs.
 *
 * What it decides (mechanical, stable):
 *   * which modules are reachable from the entry through static imports only
 *     (`await import()` defers init, so dynamic edges are NOT followed);
 *   * whether any reachable module statically imports a Node built-in.
 *
 * What it hands you instead of deciding (judgment):
 *   * the npm packages on that reachable graph. Whether a package drags Node in is
 *     a fact about published bytes, not about this repo, so it lists them and
 *     nexus-mobile-compat's protocols/vet-a-dependency.md tells you how to check one.
 *
 * Node stdlib only. Does NOT require node_modules — it never resolves package
 * internals.
 *
 * Usage:
 *   node scripts/check-mobile-imports.mjs [REPO_ROOT]
 *   node scripts/check-mobile-imports.mjs --trace src/server/MCPServer.ts
 *   node scripts/check-mobile-imports.mjs --packages
 *   node scripts/check-mobile-imports.mjs --json
 *
 * Exit codes: 0 clean, 1 violation, 2 usage error.
 *
 * Escape hatch: set NEXUS_SKIP_MOBILE_IMPORT_CHECK=1 to skip. It disables the only
 * guard this defect class has.
 */
import { readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Node core module names. A language-owned enum, not a curated list of
// real-world things: it changes only when Node adds a core module.
const NODE_BUILTINS = new Set([
    'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
    'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
    'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
    'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
    'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls',
    'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads',
    'zlib',
]);

// Provided by the Obsidian runtime and marked external in the esbuild config, so
// they never resolve to Node code in main.js.
const HOST_PROVIDED_PREFIXES = ['obsidian', 'electron', '@codemirror/'];

const SOURCE_SUFFIXES = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const RESOLVE_SUFFIXES = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];

// `import ... from '<spec>'` / `export ... from '<spec>'`, allowing the binding
// list to span lines. The body may not contain `;`, which keeps the non-greedy
// match from leaping across statements into an unrelated `from` in a string.
const FROM_IMPORT =
    /(?:^|\n)[ \t]*(import|export)\b([^;]{0,600}?)\bfrom[ \t\r\n]*(['"])([^'"]+)\3/g;
// Side-effect import: `import '<spec>'`.
const BARE_IMPORT = /(?:^|\n)[ \t]*import[ \t]+(['"])([^'"]+)\1/g;

function isFile(p) {
    try {
        return statSync(p).isFile();
    } catch {
        return false;
    }
}

function isDir(p) {
    try {
        return statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Replace comment bodies with spaces, preserving length and newlines.
 *
 * String-aware, so a `//` inside a quoted path is not mistaken for a comment.
 * Offsets stay valid, so line numbers computed on the result are real.
 */
function blankComments(text) {
    const out = [...text];
    let i = 0;
    const n = text.length;
    while (i < n) {
        const c = text[i];
        if (c === "'" || c === '"' || c === '`') {
            const quote = c;
            i += 1;
            while (i < n) {
                if (text[i] === '\\') {
                    i += 2;
                    continue;
                }
                if (text[i] === quote) {
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if (c === '/' && i + 1 < n && text[i + 1] === '/') {
            while (i < n && text[i] !== '\n') {
                out[i] = ' ';
                i += 1;
            }
            continue;
        }
        if (c === '/' && i + 1 < n && text[i + 1] === '*') {
            while (i < n && !(text[i] === '*' && i + 1 < n && text[i + 1] === '/')) {
                if (text[i] !== '\n') out[i] = ' ';
                i += 1;
            }
            for (let j = i; j < Math.min(i + 2, n); j += 1) out[j] = ' ';
            i += 2;
            continue;
        }
        i += 1;
    }
    return out.join('');
}

/**
 * True when the statement is erased before it can execute.
 *
 * `import type` / `export type` never emit. A brace list whose every specifier is
 * `type`-prefixed is elided too, and there is no default or namespace binding to
 * keep it alive.
 */
function isTypeOnly(body) {
    const trimmed = body.trim();
    if (trimmed.startsWith('type ') || trimmed === 'type') return true;
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return false;
    return inner
        .split(',')
        .filter((part) => part.trim())
        .every((part) => part.trim().startsWith('type '));
}

function countNewlines(text, end) {
    let count = 0;
    for (let i = 0; i < end; i += 1) if (text[i] === '\n') count += 1;
    return count;
}

/**
 * Return {specifier, line} for every static import statement in a file.
 *
 * Only static edges are returned; dynamic `import()` never matches these patterns
 * because the statement forms require `import <bindings> from` or `import '<spec>'`.
 */
function parseImports(file) {
    let raw;
    try {
        raw = readFileSync(file, 'utf8');
    } catch {
        return [];
    }
    const text = blankComments(raw);
    const found = [];
    const seen = new Set();

    FROM_IMPORT.lastIndex = 0;
    for (let m = FROM_IMPORT.exec(text); m !== null; m = FROM_IMPORT.exec(text)) {
        if (isTypeOnly(m[2])) continue;
        const line = countNewlines(text, m.index) + 1;
        const key = `${line}:${m[4]}`;
        if (!seen.has(key)) {
            seen.add(key);
            found.push({ spec: m[4], line });
        }
    }
    BARE_IMPORT.lastIndex = 0;
    for (let m = BARE_IMPORT.exec(text); m !== null; m = BARE_IMPORT.exec(text)) {
        const line = countNewlines(text, m.index) + 1;
        const key = `${line}:${m[2]}`;
        if (!seen.has(key)) {
            seen.add(key);
            found.push({ spec: m[2], line });
        }
    }
    return found;
}

/** Return the Node core module a specifier names, or null. */
function builtinName(spec) {
    const base = (spec.startsWith('node:') ? spec.slice(5) : spec).split('/')[0];
    return NODE_BUILTINS.has(base) ? base : null;
}

function withSuffix(p, suffix) {
    const ext = path.extname(p);
    return ext ? p.slice(0, -ext.length) + suffix : p + suffix;
}

/** Resolve a relative or `@/`-aliased specifier to a file on disk. */
function resolveLocal(spec, importer, srcRoot) {
    let base;
    if (spec.startsWith('@/')) {
        base = path.join(srcRoot, spec.slice(2));
    } else if (spec.startsWith('.')) {
        base = path.resolve(path.dirname(importer), spec);
    } else {
        return null;
    }

    // TS source imported through its emitted `.js` specifier.
    const ext = path.extname(base);
    if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
        for (const alt of ['.ts', '.tsx']) {
            const cand = withSuffix(base, alt);
            if (isFile(cand)) return cand;
        }
    }
    if (isFile(base) && SOURCE_SUFFIXES.includes(ext)) return base;
    for (const suffix of RESOLVE_SUFFIXES) {
        const cand = base + suffix;
        if (isFile(cand)) return cand;
    }
    if (isDir(base)) {
        for (const suffix of RESOLVE_SUFFIXES) {
            const cand = path.join(base, `index${suffix}`);
            if (isFile(cand)) return cand;
        }
    }
    return null;
}

/** BFS the static import graph. Returns {parents, builtinHits, packages}. */
function walk(entry, srcRoot) {
    const parents = new Map([[entry, null]]);
    const builtinHits = [];
    const packages = new Map();
    const queue = [entry];
    let head = 0;

    while (head < queue.length) {
        const current = queue[head];
        head += 1;
        for (const { spec, line } of parseImports(current)) {
            const node = builtinName(spec);
            if (node) {
                builtinHits.push({ file: current, line, specifier: spec, builtin: node });
                continue;
            }
            const target = resolveLocal(spec, current, srcRoot);
            if (target !== null) {
                if (!parents.has(target)) {
                    parents.set(target, current);
                    queue.push(target);
                }
                continue;
            }
            if (spec.startsWith('http://') || spec.startsWith('https://')) continue;
            const parts = spec.split('/');
            const pkg = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
            if (!packages.has(pkg)) packages.set(pkg, []);
            const sites = packages.get(pkg);
            const entryNote = `${current}:${line}`;
            if (!sites.includes(entryNote)) sites.push(entryNote);
        }
    }
    return { parents, builtinHits, packages };
}

/** Shortest import chain from the entry down to target, as printable paths. */
function chain(parents, target) {
    const out = [];
    let node = target;
    while (node !== null && node !== undefined) {
        out.push(node);
        node = parents.get(node);
    }
    return out.reverse();
}

function rel(root, p) {
    return path.relative(root, p);
}

/** Turn an absolute `path:line` import site into a repo-relative one. */
function relSite(site, root) {
    const idx = site.lastIndexOf(':');
    return `${rel(root, site.slice(0, idx))}:${site.slice(idx + 1)}`;
}

function isHostProvided(pkg) {
    return HOST_PROVIDED_PREFIXES.some((prefix) => pkg.startsWith(prefix));
}

function parseArgs(argv) {
    const opts = {
        repoRoot: null,
        entry: 'src/main.ts',
        src: 'src',
        trace: null,
        packages: false,
        json: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--packages') opts.packages = true;
        else if (a === '--json') opts.json = true;
        else if (a === '--trace') opts.trace = argv[++i];
        else if (a === '--entry') opts.entry = argv[++i];
        else if (a === '--src') opts.src = argv[++i];
        else if (a.startsWith('--')) {
            console.error(`error: unknown option ${a}`);
            return null;
        } else if (opts.repoRoot === null) opts.repoRoot = a;
        else {
            console.error(`error: unexpected argument ${a}`);
            return null;
        }
    }
    return opts;
}

function main() {
    if (process.env.NEXUS_SKIP_MOBILE_IMPORT_CHECK === '1') {
        console.warn(
            '[check-mobile-imports] SKIPPED via NEXUS_SKIP_MOBILE_IMPORT_CHECK=1 — ' +
            'nothing is guarding the mobile init path in this run.'
        );
        return 0;
    }

    const args = parseArgs(process.argv.slice(2));
    if (args === null) return 2;

    // Default to this script's own repo, so `npm run lint:mobile` needs no argument.
    const defaultRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const root = path.resolve(args.repoRoot ?? defaultRoot);
    const entry = path.resolve(root, args.entry);
    const srcRoot = path.resolve(root, args.src);
    if (!isFile(entry)) {
        console.error(`error: no entry point at ${entry}`);
        return 2;
    }

    const { parents, builtinHits, packages } = walk(entry, srcRoot);
    const reachable = [...parents.keys()].map((p) => rel(root, p)).sort();

    const thirdParty = [...packages.entries()]
        .filter(([pkg]) => !isHostProvided(pkg))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    if (args.trace) {
        const target = path.resolve(root, args.trace);
        const onPath = parents.has(target);
        if (args.json) {
            console.log(JSON.stringify({
                target: args.trace,
                reachable_from_init: onPath,
                chain: onPath ? chain(parents, target).map((p) => rel(root, p)) : [],
            }, null, 2));
        } else if (onPath) {
            console.log(`${args.trace} IS statically reachable from ${args.entry}:`);
            chain(parents, target).forEach((step, i) => {
                console.log(`  ${'  '.repeat(i)}${rel(root, step)}`);
            });
            console.log('\nIts top-level imports run during mobile init.');
        } else {
            console.log(`${args.trace} is NOT statically reachable from ${args.entry}.`);
            console.log('Its top-level imports do not run at init today. That is a property');
            console.log('of the current graph, not of the code: one static import from a');
            console.log('reachable module pulls it onto the startup path.');
        }
        return 0;
    }

    if (args.json) {
        console.log(JSON.stringify({
            entry: args.entry,
            reachable_module_count: reachable.length,
            node_builtin_violations: builtinHits.map((h) => ({
                file: rel(root, h.file),
                line: h.line,
                specifier: h.specifier,
                builtin: h.builtin,
            })),
            reachable_packages: Object.fromEntries(
                thirdParty.map(([pkg, sites]) => [pkg, sites.map((s) => relSite(s, root))])
            ),
            host_provided: [...packages.keys()].filter(isHostProvided).sort(),
        }, null, 2));
        return builtinHits.length ? 1 : 0;
    }

    for (const hit of builtinHits) {
        console.log(
            `${rel(root, hit.file)}:${hit.line}: static import of Node built-in ` +
            `'${hit.specifier}' on the startup path — crashes the plugin at init on mobile`
        );
        chain(parents, hit.file).forEach((step, i) => {
            console.log(`    ${'  '.repeat(i)}${rel(root, step)}`);
        });
    }

    if (args.packages || !builtinHits.length) {
        console.log(`\n${reachable.length} modules statically reachable from ${args.entry}.`);
        if (thirdParty.length) {
            console.log(
                '\nnpm packages on the startup path — each must be browser-safe ' +
                '(see protocols/vet-a-dependency.md):'
            );
            for (const [pkg, sites] of thirdParty) {
                console.log(`  ${pkg}`);
                for (const site of sites.slice(0, 3)) console.log(`      ${relSite(site, root)}`);
                if (sites.length > 3) {
                    console.log(`      ... and ${sites.length - 3} more import site(s)`);
                }
            }
        } else {
            console.log('\nNo third-party packages on the startup path.');
        }
    }

    if (builtinHits.length) {
        console.log(`\n${builtinHits.length} violation(s)`);
        return 1;
    }
    console.log('\nclean: no Node built-in is statically reachable from init');
    return 0;
}

process.exit(main());
