# Versioned Nexus tool schemas

Each Nexus release has two generated catalogs:

- `<version>/cli-tools.json` — every CLI command and its positional/flag contract, generated through `ToolCliNormalizer`.
- `<version>/mcp-tools.json` — the exact `tools/list` surface (`toolManager_getTools` and `toolManager_useTools`).

`manifest.json` maps release versions to both files and identifies `latest`.
The root `cli-first-tool-schemas.json` and `tool-schemas.json` files are current-version compatibility aliases.

## Release workflow

`npm version <bump> --no-git-tag-version` invokes `version-bump.mjs`, which regenerates both catalogs and stages them with the other version metadata. `npm run build` and release CI run `npm run schemas:check`; the build fails if the manifest, aliases, or live registries differ.

To regenerate without changing the package version:

```bash
npm run schemas:release
```

## Eval harness selection

Eval configs may pin a release:

```yaml
schemaVersion: 5.17.2
```

Omit it (or use `latest`) for the manifest's current release. `EVAL_SCHEMA_VERSION=5.17.2` overrides YAML. The harness loads MCP definitions for the model-facing `getTools`/`useTools` surface and CLI definitions for discovery, parsing, execution, and hallucination checks. Every report records the resolved version.
