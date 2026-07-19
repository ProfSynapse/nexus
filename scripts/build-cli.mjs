/**
 * Bundles the standalone `nexus` CLI (cli/nexus-cli.ts + its imports) into a
 * single self-contained nexus-cli.js at the repo root, which
 * scripts/generate-cli-content.mjs then embeds for the installer to write to a
 * machine-global location.
 *
 * Mirrors the connector build step, but the CLI is two files (nexus-cli.ts +
 * mcpLineClient.ts) so it needs bundling rather than a bare tsc emit.
 *
 * Run: node scripts/build-cli.mjs
 */
import esbuild from 'esbuild';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// Type-check the CLI first. esbuild bundles without checking types, and cli/** is
// not in the main tsconfig, so this is the only gate that catches a bad import.
const tsc = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
try {
    execFileSync(tsc, ['-p', path.join(root, 'cli', 'tsconfig.json')], { stdio: 'inherit' });
    console.log('[build-cli] tsc type-check passed');
} catch {
    console.error('[build-cli] tsc type-check FAILED — aborting bundle.');
    process.exit(1);
}

await esbuild.build({
    entryPoints: [path.join(root, 'cli', 'nexus-cli.ts')],
    outfile: path.join(root, 'nexus-cli.js'),
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    legalComments: 'none',
});

console.log('[build-cli] bundled nexus-cli.js');
