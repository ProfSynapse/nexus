/**
 * Preconditions of `scripts/verify-in-obsidian.mjs`.
 *
 * The script's whole value is its exit code: it must be safe to put in front of
 * a tag, and equally safe on a machine with no Obsidian. That means two claims
 * have to hold at once, and neither can be proven by reading the code:
 *
 *   - every "Obsidian is unavailable here" path exits **0** with a notice, so CI
 *     and contributors without the app are unaffected (a step that fails for
 *     everyone gets deleted by the next person);
 *   - a real defect — a non-empty `dev:errors` — exits **non-zero**.
 *
 * These tests drive the script the way a release does: as a subprocess, with a
 * stub `obsidian` / `obsidian-cli` on PATH standing in for the app. Stubs are
 * shell scripts, so the lane is POSIX-only; on Windows it skips rather than
 * pretending to have run.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'verify-in-obsidian.mjs');
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

interface RunResult {
  status: number | null;
  output: string;
}

describeOnPosix('scripts/verify-in-obsidian.mjs preconditions', () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'nexus-verify-'));
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Write an executable stub CLI into its own directory and return that dir. */
  function stub(name: string, binary: 'obsidian' | 'obsidian-cli', body: string): string {
    const dir = path.join(tmpRoot, name);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, binary);
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(file, 0o755);
    return dir;
  }

  function runScript(args: string[], env: Record<string, string | undefined> = {}): RunResult {
    // Start from a clean slate: an outer NEXUS_* var (a developer's own shell,
    // or a previous case) must not decide the outcome of a case.
    const base = { ...process.env };
    for (const key of Object.keys(base)) {
      if (key.startsWith('NEXUS_')) delete base[key];
    }

    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...base, ...env } as NodeJS.ProcessEnv,
    });

    return {
      status: result.status,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
  }

  /** A stub that answers every step of the loop successfully. */
  const HAPPY_BODY = `
if [ "$1" = "--version" ]; then echo "Obsidian 1.13.7"; exit 0; fi
for a in "$@"; do
  case "$a" in
    eval) echo "1"; exit 0 ;;
    plugin:reload) echo "Reloaded plugin nexus"; exit 0 ;;
    dev:errors) exit 0 ;;
  esac
done
for a in "$@"; do
  case "$a" in
    path=*) : > "\${a#path=}"; exit 0 ;;
  esac
done
exit 1`;

  describe('unavailable Obsidian exits 0 so nothing is blocked', () => {
    it('reports a missing CLI', () => {
      const { status, output } = runScript([], {
        NEXUS_OBSIDIAN_CLI: path.join(tmpRoot, 'definitely-not-installed'),
      });

      expect(output).toContain('SKIPPED');
      expect(output).toMatch(/no Obsidian CLI found/i);
      expect(status).toBe(0);
    });

    it('reports a version below 1.12.4', () => {
      const dir = stub('old', 'obsidian', 'if [ "$1" = "--version" ]; then echo "Obsidian 1.11.0"; exit 0; fi\nexit 1');
      const { status, output } = runScript([], { PATH: `${dir}:${process.env.PATH}` });

      expect(output).toContain('1.11.0');
      expect(output).toContain('1.12.4');
      expect(output).toContain('SKIPPED');
      expect(status).toBe(0);
    });

    it('reports a CLI whose version cannot be determined', () => {
      const dir = stub('nover', 'obsidian', 'echo "unknown option" >&2; exit 64');
      const { status, output } = runScript([], { PATH: `${dir}:${process.env.PATH}` });

      expect(output).toMatch(/could not determine the version/i);
      expect(status).toBe(0);
    });

    it('reports an instance that is not answering', () => {
      const dir = stub(
        'down',
        'obsidian',
        'if [ "$1" = "--version" ]; then echo "1.13.7"; exit 0; fi\necho "no running instance" >&2; exit 1'
      );
      const { status, output } = runScript(['--vault', 'demo'], { PATH: `${dir}:${process.env.PATH}` });

      expect(output).toMatch(/no running Obsidian instance/i);
      expect(status).toBe(0);
    });

    it('does not hang when the CLI never answers', () => {
      const dir = stub(
        'hang',
        'obsidian',
        'if [ "$1" = "--version" ]; then echo "1.13.7"; exit 0; fi\nsleep 120'
      );
      const { status, output } = runScript(['--vault', 'demo'], {
        PATH: `${dir}:${process.env.PATH}`,
        NEXUS_VERIFY_PROBE_TIMEOUT_MS: '2000',
      });

      expect(output).toMatch(/no response within 2000ms/);
      expect(status).toBe(0);
    });

    it('honours --require-obsidian by failing instead of skipping', () => {
      const { status, output } = runScript(['--require-obsidian'], {
        NEXUS_OBSIDIAN_CLI: path.join(tmpRoot, 'definitely-not-installed'),
      });

      expect(output).toContain('--require-obsidian was set');
      expect(status).toBe(1);
    });
  });

  describe('a reachable instance runs the loop', () => {
    it('places the CLI subcommand before the vault selector on macOS-style CLIs', () => {
      const orderedBody = `
if [ "$1" = "--version" ]; then echo "Obsidian 1.13.7"; exit 0; fi
if [ "$1" = "eval" ] && [ "$2" = "vault=demo" ]; then echo "1"; exit 0; fi
if [ "$1" = "plugin:reload" ] && [ "$3" = "vault=demo" ]; then exit 0; fi
if [ "$1" = "dev:errors" ] && [ "$2" = "vault=demo" ]; then exit 0; fi
if [ "$1" = "dev:screenshot" ] && [ "$3" = "vault=demo" ]; then : > "\${2#path=}"; exit 0; fi
exit 64`;
      const dir = stub('ordered', 'obsidian', orderedBody);
      const { status, output } = runScript(
        ['--vault', 'demo', '--skip-build', '--artifacts-dir', path.join(tmpRoot, 'artifacts-ordered')],
        { NEXUS_OBSIDIAN_CLI: path.join(dir, 'obsidian') }
      );

      expect(output).toContain('VERIFIED');
      expect(status).toBe(0);
    });

    it('resolves the CLI under the obsidian-cli name and passes on a clean dev:errors', () => {
      const dir = stub('happy', 'obsidian-cli', HAPPY_BODY);
      const artifacts = path.join(tmpRoot, 'artifacts');
      const { status, output } = runScript(
        ['--vault', 'demo', '--skip-build', '--artifacts-dir', artifacts],
        { NEXUS_OBSIDIAN_CLI: path.join(dir, 'obsidian-cli') }
      );

      expect(output).toContain('dev:errors is clean');
      expect(output).toContain('VERIFIED');
      expect(status).toBe(0);
      // The screenshot artifact landed where it was asked to.
      expect(readdirSync(artifacts).filter((f) => f.endsWith('.png'))).toHaveLength(1);
    });

    it('fails when dev:errors reports anything', () => {
      const dir = stub(
        'dirty',
        'obsidian-cli',
        HAPPY_BODY.replace('dev:errors) exit 0 ;;', 'dev:errors) echo "Error: Database not initialized"; exit 0 ;;')
      );
      const { status, output } = runScript(
        ['--vault', 'demo', '--skip-build', '--artifacts-dir', path.join(tmpRoot, 'artifacts-dirty')],
        { NEXUS_OBSIDIAN_CLI: path.join(dir, 'obsidian-cli') }
      );

      expect(output).toContain('FAILED');
      expect(output).toContain('Database not initialized');
      expect(status).toBe(1);
    });

    it('fails on an unrecognised dev:errors payload rather than waving it through', () => {
      const dir = stub(
        'weird',
        'obsidian-cli',
        HAPPY_BODY.replace('dev:errors) exit 0 ;;', 'dev:errors) echo "<unparseable banner>"; exit 0 ;;')
      );
      const { status, output } = runScript(
        ['--vault', 'demo', '--skip-build', '--artifacts-dir', path.join(tmpRoot, 'artifacts-weird')],
        { NEXUS_OBSIDIAN_CLI: path.join(dir, 'obsidian-cli') }
      );

      expect(output).toContain('FAILED');
      expect(status).toBe(1);
    });
  });

  it('rejects an unknown option with exit 2 rather than running anything', () => {
    const { status, output } = runScript(['--not-a-flag']);

    expect(output).toContain('unknown option');
    expect(status).toBe(2);
  });
});
