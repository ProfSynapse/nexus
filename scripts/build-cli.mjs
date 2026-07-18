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
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

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
