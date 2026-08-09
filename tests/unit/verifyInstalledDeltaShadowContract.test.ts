import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPOSITORY_ROOT = resolve(__dirname, '../..');
const VERIFIER = resolve(REPOSITORY_ROOT, 'scripts/verify-installed-delta-shadow-contract.mjs');
const SOURCE_MANIFEST_PATH = resolve(REPOSITORY_ROOT, 'manifest.json');
const SOURCE_MAIN_PATH = resolve(REPOSITORY_ROOT, 'main.js');

type PluginManifest = { id: string; version: string };
let sourceManifest: PluginManifest;
let sourceMain: Buffer;
let temporaryDirectories: string[] = [];

async function createInstalledPlugin(options: {
  manifest?: PluginManifest;
  main?: Buffer;
} = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-delta-shadow-contract-'));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(options.manifest ?? sourceManifest));
  await writeFile(join(directory, 'main.js'), options.main ?? sourceMain);
  return directory;
}

function runVerifier(installedDirectory: string) {
  return spawnSync(process.execPath, [VERIFIER], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: { ...process.env, NEXUS_PLUGIN_DIR: installedDirectory }
  });
}

beforeAll(async () => {
  sourceManifest = JSON.parse(await readFile(SOURCE_MANIFEST_PATH, 'utf8')) as PluginManifest;
  sourceMain = await readFile(SOURCE_MAIN_PATH);
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.map(directory => rm(directory, { recursive: true, force: true })));
  temporaryDirectories = [];
});

describe('verify-installed-delta-shadow-contract', () => {
  it('accepts matching source and installed bundles and reports the source version', async () => {
    expect(sourceManifest.id).toBe('nexus');
    expect(typeof sourceManifest.version).toBe('string');
    expect(sourceManifest.version.length).toBeGreaterThan(0);
    const result = runVerifier(await createInstalledPlugin());

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: 'thinkbox-nexus-delta-shadow-contract/v1',
      version: sourceManifest.version,
      bundleParity: true
    });
    expect(result.stderr).toBe('');
  });

  it('rejects an installed manifest with a different version before hashing', async () => {
    const result = runVerifier(await createInstalledPlugin({
      manifest: { ...sourceManifest, version: '5.16.1' }
    }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source and installed manifests differ semantically');
    expect(result.stderr).toContain(`nexus@${sourceManifest.version} != nexus@5.16.1`);
  });

  it('rejects a byte-different installed main.js after matching manifest identity', async () => {
    const result = runVerifier(await createInstalledPlugin({
      main: Buffer.concat([sourceMain, Buffer.from('\n// byte mismatch\n')])
    }));

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      version: sourceManifest.version,
      bundleParity: false
    });
    expect(result.stderr).toContain('source and installed main.js SHA-256 differ');
  });
});
