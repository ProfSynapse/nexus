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
 * The check itself is the reachability walker shipped with the nexus-mobile-compat
 * skill (`scripts/check_mobile_imports.py`). This wrapper only finds a Python 3 and
 * runs it, so the gate can live in `npm run lint` / `npm run build` on every
 * platform. It deliberately does NOT reimplement the walk — one implementation,
 * one set of rules.
 *
 * Run: node scripts/check-mobile-imports.mjs [extra args passed to the checker]
 *
 * Exit codes: 0 clean, 1 violation (or no usable Python 3), 2 checker usage error.
 *
 * Escape hatch: set NEXUS_SKIP_MOBILE_IMPORT_CHECK=1 to skip. Only for an
 * environment that genuinely cannot install Python 3 — it disables the only guard
 * this defect class has.
 */
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// `.skills/` is the source of truth; the agent folders are generated mirrors
// (see CLAUDE.md). Prefer the source, fall back to a mirror so a checkout that
// only carries the mirrors still gates.
const CHECKER_CANDIDATES = [
    path.join(root, '.skills', 'nexus-mobile-compat', 'scripts', 'check_mobile_imports.py'),
    path.join(root, '.claude', 'skills', 'nexus-mobile-compat', 'scripts', 'check_mobile_imports.py'),
];

// `py -3` first on Windows: `python3` there is usually the Microsoft Store alias
// stub, which exits 9009 without running anything.
const PYTHON_CANDIDATES =
    process.platform === 'win32'
        ? [['py', '-3'], ['python'], ['python3']]
        : [['python3'], ['python'], ['py', '-3']];

if (process.env.NEXUS_SKIP_MOBILE_IMPORT_CHECK === '1') {
    console.warn(
        '[check-mobile-imports] SKIPPED via NEXUS_SKIP_MOBILE_IMPORT_CHECK=1 — ' +
        'nothing is guarding the mobile init path in this run.'
    );
    process.exit(0);
}

const checker = CHECKER_CANDIDATES.find(existsSync);
if (!checker) {
    console.error(
        '[check-mobile-imports] checker script not found. Expected one of:\n' +
        CHECKER_CANDIDATES.map((c) => `  ${path.relative(root, c)}`).join('\n')
    );
    process.exit(1);
}

function isPython3(cmd) {
    const probe = spawnSync(cmd[0], [...cmd.slice(1), '--version'], {
        encoding: 'utf8',
        shell: process.platform === 'win32',
    });
    if (probe.error || probe.status !== 0) return false;
    return /^Python 3\./m.test(`${probe.stdout ?? ''}${probe.stderr ?? ''}`);
}

const python = PYTHON_CANDIDATES.find(isPython3);
if (!python) {
    console.error(
        '[check-mobile-imports] no Python 3 interpreter found (tried: ' +
        PYTHON_CANDIDATES.map((c) => c.join(' ')).join(', ') + ').\n' +
        'The mobile reachability checker is a Python 3 script; Python 3 is a build\n' +
        'prerequisite for this repo. Install it (python.org, brew, apt, winget), or\n' +
        'set NEXUS_SKIP_MOBILE_IMPORT_CHECK=1 to build without the guard — knowing that\n' +
        'a mobile init crash can then land unnoticed.'
    );
    process.exit(1);
}

const args = process.argv.slice(2);
const result = spawnSync(python[0], [...python.slice(1), checker, root, ...args], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
});

if (result.error) {
    console.error(`[check-mobile-imports] failed to run checker: ${result.error.message}`);
    process.exit(1);
}

process.exit(result.status ?? 1);
