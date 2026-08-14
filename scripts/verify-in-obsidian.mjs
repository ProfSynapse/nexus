#!/usr/bin/env node
/**
 * In-app verification loop (Obsidian CLI).
 *
 * Answers the one question Jest cannot: does the plugin actually load and run
 * inside Obsidian? Every Jest lane resolves `obsidian` to `tests/mocks/obsidian/`,
 * so a green suite proves the code agrees with the mock — not with the app. This
 * script drives the real thing:
 *
 *   1. `npm run build`                     (skippable with --skip-build)
 *   2. `<cli> plugin:reload id=<plugin>`
 *   3. `<cli> dev:errors`                  → FAIL if it reports anything
 *   4. `<cli> dev:screenshot path=…`       → artifact for a human
 *
 * Design plan: docs/plans/obsidian-cli-verification-plan.md (§4.1).
 * Manual procedure this automates: .claude/skills/nexus-testing/protocols/live-loop.md
 *
 * ## Exit codes — the contract callers gate on
 *
 *   0  verified, OR skipped because Obsidian is unavailable here
 *   1  verification failed (build, reload, or a non-empty dev:errors)
 *   2  usage error (bad argument)
 *
 * Skipping exits 0 **on purpose**. A verification step that fails for everyone
 * without the app installed — CI, contributors on a headless box — is a step the
 * next person deletes. Every precondition below is detected and reported, never
 * crashed on:
 *
 *   - non-desktop platform (the CLI is desktop-only)
 *   - no Obsidian CLI on PATH (the binary is `obsidian` on some installs and
 *     `obsidian-cli` on others — both are probed, in that order)
 *   - a CLI whose version cannot be determined
 *   - Obsidian older than 1.12.4, where the CLI is not generally available
 *   - no running instance answering the CLI
 *
 * Pass --require-obsidian (or NEXUS_REQUIRE_OBSIDIAN=1) to turn any of those
 * skips into a failure — for a machine that is supposed to have Obsidian, such
 * as the headless container in
 * .claude/skills/nexus-testing/protocols/headless-obsidian.md.
 *
 * ## What it does NOT prove
 *
 * That the vault under test is running THIS build. `npm run build` writes
 * `main.js` into the repo root; the reload picks up whatever is installed in the
 * target vault's `.obsidian/plugins/<id>/`. Unless that folder is a symlink to
 * this checkout (or you ran your own deploy step first), you are verifying an
 * older bundle. The run prints the vault it targeted so this is visible.
 *
 * Mobile is untouched by this: `dev:mobile` emulates the environment, not the
 * absence of Node, so an init crash on a phone will not reproduce here. That is
 * `npm run lint:mobile`'s job.
 *
 * ## Usage
 *
 *   npm run verify:obsidian
 *   npm run verify:obsidian -- --vault my-vault
 *   npm run verify:obsidian -- --skip-build --artifacts-dir test-artifacts/x
 *
 * Options:
 *   --vault <name>          vault to target. STRONGLY recommended for an
 *                           unattended run: the CLI's default follows window
 *                           focus, so an unattended run without it can reload the
 *                           plugin in whichever vault happens to be in front.
 *   --plugin-id <id>        default: read from manifest.json
 *   --artifacts-dir <path>  default: test-artifacts/obsidian-verify (gitignored)
 *   --skip-build            reuse the bundle already on disk
 *   --require-obsidian      unavailable preconditions fail instead of skipping
 *   --timeout <ms>          per-CLI-command timeout (default 120000)
 *   --help
 *
 * Environment:
 *   NEXUS_OBSIDIAN_CLI      explicit path/name of the CLI binary
 *   NEXUS_OBSIDIAN_VERSION  skip version probing (report only what it says)
 *   NEXUS_VERIFY_VAULT      same as --vault
 *   NEXUS_REQUIRE_OBSIDIAN  =1, same as --require-obsidian
 *   NEXUS_SKIP_OBSIDIAN_VERIFY =1, skip immediately with exit 0
 *   NEXUS_VERIFY_PROBE_TIMEOUT_MS  precondition probe budget (default 30000)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const TAG = '[verify-in-obsidian]';
const MIN_OBSIDIAN_VERSION = '1.12.4';
const CLI_CANDIDATES = ['obsidian', 'obsidian-cli'];
const DESKTOP_PLATFORMS = ['darwin', 'win32', 'linux'];
const DEFAULT_TIMEOUT_MS = 120_000;
/**
 * Preconditions get their own, shorter budget: a cold start the CLI triggered
 * must not hold an unattended run hostage. Overridable for a slow machine.
 */
const PROBE_TIMEOUT_MS = (() => {
    const raw = Number.parseInt(process.env.NEXUS_VERIFY_PROBE_TIMEOUT_MS ?? '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
})();

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const isWindows = process.platform === 'win32';

// ── output helpers ───────────────────────────────────────────────────────────

function info(message) {
    console.log(`${TAG} ${message}`);
}

function step(message) {
    console.log(`${TAG} → ${message}`);
}

/** A precondition is unmet. Exit 0 unless the caller demanded Obsidian. */
function skip(reason, hint) {
    const lines = [`${TAG} SKIPPED — ${reason}`];
    if (hint) lines.push(`${TAG}   ${hint}`);
    if (options.requireObsidian) {
        lines.push(`${TAG}   --require-obsidian was set, so this is a failure.`);
        console.error(lines.join('\n'));
        process.exit(EXIT_FAILED);
    }
    lines.push(`${TAG}   Nothing was verified in the app. Exiting 0 so this does not block CI.`);
    console.log(lines.join('\n'));
    process.exit(EXIT_OK);
}

/** The loop ran and something was wrong. Always non-zero. */
function fail(reason, detail) {
    console.error(`${TAG} FAILED — ${reason}`);
    if (detail) {
        for (const line of String(detail).split(/\r?\n/)) {
            console.error(`${TAG}   | ${line}`);
        }
    }
    process.exit(EXIT_FAILED);
}

// ── argument parsing ─────────────────────────────────────────────────────────

const HELP = `Usage: node scripts/verify-in-obsidian.mjs [options]

  --vault <name>          vault to target (default: the CLI's own default,
                          which follows window focus)
  --plugin-id <id>        default: read from manifest.json
  --artifacts-dir <path>  default: test-artifacts/obsidian-verify
  --skip-build            reuse the bundle already on disk
  --require-obsidian      unavailable preconditions fail instead of skipping
  --timeout <ms>          per-CLI-command timeout (default ${DEFAULT_TIMEOUT_MS})
  --help

Exit codes: 0 verified or skipped, 1 verification failed, 2 usage error.`;

function parseArgs(argv) {
    const parsed = {
        vault: process.env.NEXUS_VERIFY_VAULT?.trim() || null,
        pluginId: null,
        artifactsDir: null,
        skipBuild: false,
        requireObsidian: process.env.NEXUS_REQUIRE_OBSIDIAN === '1',
        timeoutMs: DEFAULT_TIMEOUT_MS,
    };

    const needsValue = (flag, value) => {
        if (value === undefined) {
            console.error(`${TAG} ${flag} requires a value.\n\n${HELP}`);
            process.exit(EXIT_USAGE);
        }
        return value;
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case '--help':
            case '-h':
                console.log(HELP);
                process.exit(EXIT_OK);
                break;
            case '--vault':
                parsed.vault = needsValue(arg, argv[++i]);
                break;
            case '--plugin-id':
                parsed.pluginId = needsValue(arg, argv[++i]);
                break;
            case '--artifacts-dir':
                parsed.artifactsDir = needsValue(arg, argv[++i]);
                break;
            case '--skip-build':
                parsed.skipBuild = true;
                break;
            case '--require-obsidian':
                parsed.requireObsidian = true;
                break;
            case '--timeout': {
                const raw = needsValue(arg, argv[++i]);
                const ms = Number.parseInt(raw, 10);
                if (!Number.isFinite(ms) || ms <= 0) {
                    console.error(`${TAG} --timeout expects a positive integer (ms), got "${raw}".`);
                    process.exit(EXIT_USAGE);
                }
                parsed.timeoutMs = ms;
                break;
            }
            default:
                console.error(`${TAG} unknown option "${arg}".\n\n${HELP}`);
                process.exit(EXIT_USAGE);
        }
    }

    return parsed;
}

const options = parseArgs(process.argv.slice(2));

// ── process helpers ──────────────────────────────────────────────────────────

/**
 * spawnSync runs through a shell on Windows (so `.cmd`/`.bat` shims resolve),
 * which means an argument containing a space — a screenshot path under
 * "C:\Users\Some Name\…" — would be re-split by the shell. Quote those.
 */
function shellSafe(args) {
    if (!isWindows) return args;
    return args.map((arg) => (/\s/.test(arg) && !/^".*"$/.test(arg) ? `"${arg}"` : arg));
}

/**
 * Run a command and capture its output. Never throws: a missing binary, a
 * crash and a timeout all come back as a plain result object.
 */
function run(command, args, { timeoutMs = options.timeoutMs, cwd = root } = {}) {
    const result = spawnSync(command, shellSafe(args), {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        shell: isWindows,
        windowsHide: true,
    });

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    return {
        ok: !result.error && result.status === 0,
        status: result.status,
        signal: result.signal,
        timedOut: result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM',
        error: result.error ?? null,
        stdout,
        stderr,
        output: `${stdout}${stderr}`.trim(),
    };
}

/** Run a command with its output streamed to this process's stdio. */
function runInherit(command, args, { cwd = root, timeoutMs = null } = {}) {
    const result = spawnSync(command, shellSafe(args), {
        cwd,
        stdio: 'inherit',
        shell: isWindows,
        windowsHide: true,
        ...(timeoutMs ? { timeout: timeoutMs } : {}),
    });
    return { ok: !result.error && result.status === 0, status: result.status, error: result.error ?? null };
}

function which(command) {
    if (command.includes('/') || command.includes('\\') || path.isAbsolute(command)) {
        return existsSync(command) ? command : null;
    }
    const finder = isWindows ? 'where' : 'which';
    const result = run(finder, [command], { timeoutMs: PROBE_TIMEOUT_MS });
    if (!result.ok) return null;
    const first = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return first ?? null;
}

// ── version handling ─────────────────────────────────────────────────────────

function parseVersion(text) {
    const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(text ?? '');
    return match ? match[0] : null;
}

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    return 0;
}

/**
 * Ask the CLI what version it is. Returns null when no probe produced a
 * parseable version — which is reported as "unknown", never assumed to be fine.
 */
function detectVersion(cli) {
    const override = process.env.NEXUS_OBSIDIAN_VERSION?.trim();
    if (override) {
        const parsed = parseVersion(override);
        return parsed ? { version: parsed, source: 'NEXUS_OBSIDIAN_VERSION' } : null;
    }

    for (const probe of [['--version'], ['version']]) {
        const result = run(cli, probe, { timeoutMs: PROBE_TIMEOUT_MS });
        if (!result.ok) continue;
        const version = parseVersion(result.output);
        if (version) return { version, source: `${cli} ${probe.join(' ')}` };
    }
    return null;
}

// ── dev:errors interpretation ────────────────────────────────────────────────

/**
 * Decide whether a `dev:errors` payload means "clean".
 *
 * Fails closed: anything not recognised as an explicit empty result is treated
 * as errors. live-loop.md's rule is that unparseable CLI output is UNKNOWN and
 * never a pass, and the whole point of this script is to be gateable — so an
 * output shape we do not recognise stops the release rather than waving it
 * through. The raw text is always printed so a human can see what it was.
 */
function isErrorOutputClean(text) {
    const trimmed = (text ?? '').trim();
    if (!trimmed) return true;
    if (/^\[\s*\]$/.test(trimmed)) return true;                       // []
    if (/^\{\s*"?errors"?\s*:\s*\[\s*\]\s*\}$/.test(trimmed)) return true;  // {"errors":[]}
    if (/^no\s+errors?\b/i.test(trimmed)) return true;                // "No errors"
    if (/^0\s+errors?\b/i.test(trimmed)) return true;                 // "0 errors"
    return false;
}

// ── preconditions ────────────────────────────────────────────────────────────

function readPluginId() {
    if (options.pluginId) return options.pluginId;
    try {
        const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
        if (typeof manifest.id === 'string' && manifest.id.trim()) return manifest.id.trim();
    } catch (error) {
        info(`could not read manifest.json (${error.message}); pass --plugin-id.`);
    }
    return null;
}

function checkPlatform() {
    if (!DESKTOP_PLATFORMS.includes(process.platform)) {
        skip(
            `platform "${process.platform}" is not a desktop platform.`,
            'The Obsidian CLI drives a desktop app; there is nothing to verify here.'
        );
    }
    if (process.env.TERMUX_VERSION) {
        skip(
            'running under Termux, which is Android, not desktop.',
            'The Obsidian CLI drives a desktop app; there is nothing to verify here.'
        );
    }
}

function resolveCli() {
    const override = process.env.NEXUS_OBSIDIAN_CLI?.trim();
    const candidates = override ? [override] : CLI_CANDIDATES;

    for (const candidate of candidates) {
        const resolved = which(candidate);
        if (resolved) return { command: candidate, resolvedPath: resolved };
    }

    skip(
        `no Obsidian CLI found on PATH (tried: ${candidates.join(', ')}).`,
        'Install Obsidian 1.12.4+ and enable Settings → General → Advanced → Command line ' +
        'interface, or set NEXUS_OBSIDIAN_CLI to the binary.'
    );
    return null; // unreachable; keeps the shape obvious
}

function checkVersion(cli) {
    const detected = detectVersion(cli);
    if (!detected) {
        skip(
            `could not determine the version of "${cli}".`,
            `Neither \`${cli} --version\` nor \`${cli} version\` returned a version string. ` +
            'Set NEXUS_OBSIDIAN_VERSION=x.y.z if you know it is new enough.'
        );
        return null;
    }

    if (compareVersions(detected.version, MIN_OBSIDIAN_VERSION) < 0) {
        skip(
            `Obsidian ${detected.version} is older than ${MIN_OBSIDIAN_VERSION}, where the CLI became generally available.`,
            `Version reported by: ${detected.source}. Update Obsidian to run this check.`
        );
        return null;
    }

    return detected;
}

/**
 * Confirm an instance is actually answering. `eval code=1` is read-only and
 * cheap. A timeout counts as "not answering": the CLI launches the app when it
 * is not running, and an unattended run must not sit waiting on a cold start.
 */
function checkInstanceRunning(cli, vaultArgs) {
    const result = run(cli, [...vaultArgs, 'eval', 'code=1'], { timeoutMs: PROBE_TIMEOUT_MS });
    if (result.ok) return;

    const detail = result.timedOut
        ? `no response within ${PROBE_TIMEOUT_MS}ms`
        : (result.output || result.error?.message || `exit status ${result.status}`);

    skip(
        'no running Obsidian instance answered the CLI.',
        `Probe: \`${cli} ${[...vaultArgs, 'eval', 'code=1'].join(' ')}\` — ${detail}. ` +
        'Start Obsidian (and check the CLI toggle in Settings → General → Advanced).'
    );
}

// ── the loop ─────────────────────────────────────────────────────────────────

function main() {
    if (process.env.NEXUS_SKIP_OBSIDIAN_VERIFY === '1') {
        info('SKIPPED via NEXUS_SKIP_OBSIDIAN_VERIFY=1 — nothing was verified in the app.');
        process.exit(EXIT_OK);
    }

    // --- preconditions: every failure here exits 0 with a notice -------------
    let cli;
    let version;
    let pluginId;
    let vaultArgs;
    try {
        checkPlatform();

        pluginId = readPluginId();
        if (!pluginId) {
            skip('could not resolve the plugin id.', 'Pass --plugin-id <id>.');
        }

        const resolved = resolveCli();
        cli = resolved.command;
        info(`CLI: ${cli} (${resolved.resolvedPath})`);

        version = checkVersion(cli);
        info(`Obsidian ${version.version} (via ${version.source}) — minimum is ${MIN_OBSIDIAN_VERSION}.`);

        vaultArgs = options.vault ? [`vault=${options.vault}`] : [];
        if (!options.vault) {
            info(
                'no --vault given: the CLI will use its own default, which follows window focus. ' +
                'Pass --vault <name> for an unattended run.'
            );
        }

        checkInstanceRunning(cli, vaultArgs);
        info(`instance is answering${options.vault ? ` for vault "${options.vault}"` : ''}.`);
    } catch (error) {
        // A precondition check itself blew up. Still a skip, never a crash.
        skip(
            `precondition check failed unexpectedly: ${error.message}`,
            'This is a bug in scripts/verify-in-obsidian.mjs, not a verification failure.'
        );
        return;
    }

    // --- verification: failures here are real and exit non-zero --------------

    // 1. Build.
    if (options.skipBuild) {
        info('--skip-build: reusing the bundle already on disk.');
    } else {
        step('npm run build');
        const build = runInherit(isWindows ? 'npm.cmd' : 'npm', ['run', 'build']);
        if (!build.ok) {
            fail('`npm run build` failed — nothing was reloaded.', build.error?.message);
        }
    }

    // 2. Reload the plugin.
    const reloadArgs = [...vaultArgs, 'plugin:reload', `id=${pluginId}`];
    step(`${cli} ${reloadArgs.join(' ')}`);
    const reload = run(cli, reloadArgs);
    if (!reload.ok) {
        fail(
            `plugin:reload failed (${reload.timedOut ? 'timed out' : `exit ${reload.status}`}).`,
            reload.output || reload.error?.message
        );
    }
    if (reload.output) info(`reload said: ${reload.output.split(/\r?\n/)[0]}`);

    // 3. dev:errors — the assertion.
    const errorArgs = [...vaultArgs, 'dev:errors'];
    step(`${cli} ${errorArgs.join(' ')}`);
    const errors = run(cli, errorArgs);
    if (!errors.ok && !errors.output) {
        fail(
            `dev:errors could not be read (${errors.timedOut ? 'timed out' : `exit ${errors.status}`}).`,
            errors.error?.message
        );
    }
    if (!isErrorOutputClean(errors.output)) {
        fail(
            `dev:errors is not empty after reloading "${pluginId}".`,
            errors.output
        );
    }
    info('dev:errors is clean.');

    // 4. Screenshot — an artifact for a human, never an assertion. A failure
    //    here is reported but does not fail the run: the gate is dev:errors.
    const artifactsDir = path.resolve(
        root,
        options.artifactsDir ?? path.join('test-artifacts', 'obsidian-verify')
    );
    let screenshotPath = null;
    try {
        mkdirSync(artifactsDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        screenshotPath = path.join(artifactsDir, `verify-${stamp}.png`);
        const shotArgs = [...vaultArgs, 'dev:screenshot', `path=${screenshotPath}`];
        step(`${cli} ${shotArgs.join(' ')}`);
        const shot = run(cli, shotArgs);
        if (!shot.ok || !existsSync(screenshotPath)) {
            console.warn(
                `${TAG} WARNING: screenshot not written (${shot.output || shot.error?.message || `exit ${shot.status}`}). ` +
                'Verification still passed — the gate is dev:errors, not the image.'
            );
            screenshotPath = null;
        }
    } catch (error) {
        console.warn(`${TAG} WARNING: could not write the screenshot artifact: ${error.message}`);
        screenshotPath = null;
    }

    // --- summary ------------------------------------------------------------
    info('VERIFIED in the running app:');
    info(`  plugin      ${pluginId}`);
    info(`  vault       ${options.vault ?? '(CLI default — follows window focus)'}`);
    info(`  obsidian    ${version.version}`);
    info(`  build       ${options.skipBuild ? 'reused from disk' : 'npm run build'}`);
    info(`  screenshot  ${screenshotPath ?? '(not captured)'}`);
    info('Reminder: this reloaded whatever build the vault has installed. If that folder is');
    info('not a symlink to this checkout, deploy first or you verified an older bundle.');
    process.exit(EXIT_OK);
}

main();
