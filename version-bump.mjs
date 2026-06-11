import { readFileSync, writeFileSync } from 'fs';

// Invoked by the npm `version` lifecycle script. Syncs the bumped version into
// manifest.json and records the version -> minAppVersion mapping in
// versions.json so older Obsidian clients can resolve a compatible release.
const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  console.error('version-bump: npm_package_version is not set');
  process.exit(1);
}

// manifest.json uses 2-space indentation; preserve it.
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');

// versions.json uses tab indentation; preserve it.
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
versions[targetVersion] = minAppVersion;
writeFileSync('versions.json', JSON.stringify(versions, null, '\t') + '\n');
