# `scripts`

Build/dev helper scripts used by the plugin toolchain.

## What's Here

- `generate-connector-content.mjs` — Generates/patches content used by the external `connector.js` build step.
- `patch-webllm-ffi.js` — Post-processing/patching for WebLLM integration (build-time fixups).
- `generate-folder-readmes.mjs` — Generates per-folder `README.md` files for the repo (lightweight audit maps).

## Improvement Ideas

- Add a short “when to run this” note to each script header (inputs/outputs).
- Consider making scripts idempotent and/or supporting `--dry-run` consistently.
- See `CODEBASE_AUDIT.md` (repo root) for cross-cutting cleanup opportunities.
