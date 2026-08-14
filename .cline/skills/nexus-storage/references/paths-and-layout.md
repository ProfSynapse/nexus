# Roots, on-disk layout, and cache backends

Where Nexus data actually lives, and how to ask the tree instead of trusting a
path written down anywhere:

```bash
grep -rn "resolveVaultRoot\|resolvePluginStorageRoot" src/ --include=*.ts
sed -n '1,60p' src/database/storage/vaultRoot/EventStreamUtilities.ts
```

## Two resolvers, two jobs

**`resolveVaultRoot(settings, { configDir })`** — src/database/storage/VaultRootResolver.ts.
Takes the storage settings, returns a `VaultRootResolution`: `configuredPath`,
`resolvedPath`, `guidesPath`, `dataPath`, `maxShardBytes`, and a `validation`
record. The event store lives under `dataPath`. This is the synced root the user
controls; the resolver normalizes and validates the configured path rather than
trusting it.

**`resolvePluginStorageRoot(app, plugin)`** — src/database/storage/PluginStoragePathResolver.ts.
Returns `pluginDir`, `dataJsonPath`, `dataRoot`, `migrationRoot`, and
`compatibilityDataRoots`. The active plugin folder name comes from
`plugin.manifest.dir` (falling back to `manifest.id`), which is why the folder name
cannot be assumed. `compatibilityDataRoots` covers the other known folder names and
exists **for reads and migration only** — never write there.

Neither root is a constant. A literal `Nexus` or `.nexus` in new code is a bug on
every install whose settings or folder name differ from yours.

## Event store on disk

A logical stream is `<category>/<id>`, where category is one of the values in
`EVENT_STREAM_CATEGORIES` (EventStreamUtilities.ts). `VaultEventStore` builds
`relativeStreamPath = <category>/<normalizedId>` and `ShardedJsonlStreamStore`
turns that into a **directory** under `dataPath`, holding shard files named
`shard-NNNNNN.jsonl`.

So the on-disk shape is:

```
<dataPath>/<category>/<id>/shard-000000.jsonl
```

The bare id is not a directory name and there is no single `<id>.jsonl` file. A
glob that finds nothing has usually lost the category prefix or is looking for a
file where a directory sits. Conversation ids are additionally normalized
(repeated `conv_conv_` prefixes collapse) before they become paths.

Shard filenames matter: `SHARD_FILE_PATTERN` matches canonical shards, and a
separate pattern recognises cloud-sync conflict siblings such as
`shard-000001 (1).jsonl`. A canonical shard and its conflict sibling are distinct
files with disjoint events, which is why `shard_cursors` is keyed by the full
filename per device and must not be collapsed by shard index.

## Cache backends, and the cloud-sync rule

`createCacheBlobStore` (src/database/storage/CacheBlobStoreFactory.ts) picks the
backend by platform: **IndexedDB on desktop, the vault adapter file on mobile**.
The IDB record key comes from `computeIdbKey`, which prefers Obsidian's runtime
`app.appId` and falls back to a hash of the vault base path.

This split is not a preference. The desktop cache moved out of the vault because a
large `cache.db` inside a cloud-synced folder conflict-copies mid-write and hangs
hydration until `waitForQueryReady` times out. The full incident and design are in
docs/architecture/cloud-sync-cache-backend.md.

**Never move cache data back under a synced path**, and never assume the cache is
a file you can read on desktop.

Migration from the legacy in-vault `cache.db` to IDB, plus the one-shot janitor
that deletes conflict copies, lives in src/database/migration/CacheBackendMigration.ts.
`CONFLICT_COPY_PATTERNS` there is a list of regexes matched against filenames; if
you extend it, verify by running the patterns against real filenames rather than
reading them (see `failure-modes.md`).
