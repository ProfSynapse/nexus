import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = 'thinkbox-nexus-delta-shadow-contract/v1';
const EXPECTED_ID = 'nexus';
const SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  throw new Error(message);
}

async function readManifest(directory, label) {
  const path = join(directory, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    fail(`${label} manifest unavailable or invalid at ${path}: ${String(error)}`);
  }

  if (
    manifest === null
    || typeof manifest !== 'object'
    || typeof manifest.id !== 'string'
    || manifest.id.length === 0
    || typeof manifest.version !== 'string'
    || manifest.version.length === 0
  ) {
    fail(
      `${label} manifest must contain non-empty string id and version; ` +
      `received ${String(manifest?.id)}@${String(manifest?.version)}`
    );
  }
  return manifest;
}

async function hashMain(directory, label) {
  const path = join(directory, 'main.js');
  let content;
  try {
    content = await readFile(path);
  } catch (error) {
    fail(`${label} main.js unavailable at ${path}: ${String(error)}`);
  }
  return createHash('sha256').update(content).digest('hex');
}

async function main() {
  const installedDirValue = process.env.NEXUS_PLUGIN_DIR;
  if (!installedDirValue) {
    fail('NEXUS_PLUGIN_DIR is required');
  }
  const installedDir = resolve(installedDirValue);

  const sourceManifest = await readManifest(SOURCE_DIR, 'source');
  if (sourceManifest.id !== EXPECTED_ID) {
    fail(
      `source manifest must identify ${EXPECTED_ID}; ` +
      `received ${sourceManifest.id}@${sourceManifest.version}`
    );
  }

  const installedManifest = await readManifest(installedDir, 'installed');
  if (
    sourceManifest.id !== installedManifest.id
    || sourceManifest.version !== installedManifest.version
  ) {
    fail(
      'source and installed manifests differ semantically: ' +
      `${sourceManifest.id}@${sourceManifest.version} != ` +
      `${installedManifest.id}@${installedManifest.version}`
    );
  }

  const sourceMainSha256 = await hashMain(SOURCE_DIR, 'source');
  const installedMainSha256 = await hashMain(installedDir, 'installed');
  const bundleParity = sourceMainSha256 === installedMainSha256;
  const result = {
    schema: SCHEMA,
    version: sourceManifest.version,
    sourceMainSha256,
    installedMainSha256,
    bundleParity
  };

  console.log(JSON.stringify(result, null, 2));
  if (!bundleParity) {
    fail('source and installed main.js SHA-256 differ; deployment is required');
  }
}

main().catch(error => {
  console.error(`[delta-shadow-contract] ${String(error)}`);
  process.exitCode = 1;
});
