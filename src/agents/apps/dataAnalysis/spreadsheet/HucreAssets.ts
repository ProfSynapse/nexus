/**
 * HucreAssets — vendors the `hucre/xlsx` engine as a runtime asset, mirroring
 * {@link PyodideEnsurer}. hucre's xlsx entry is ~302 KB minified, which exceeds
 * main.js's ~218 KB headroom against the 5 MB ceiling (measured in spike S2,
 * docs/plans/spike-findings-hucre-2026-05-31.md), so it must NEVER be bundled —
 * it is fetched once and loaded from the plugin's `hucre` folder thereafter.
 *
 * The asset is the dependency-bundled ESM build of the `hucre/xlsx` subpath
 * (esm.sh resolves hucre's internal `./xlsx/*.mjs` parts into one file).
 *
 * ⚠️ PENDING Electron validation: the download (requestUrl) + the
 * `import(file://…)` load path must be exercised in a real Obsidian desktop
 * build. Only the pinned manifest below is unit-tested; the fetch/load mechanics
 * are not runnable in the headless container.
 */

export const HUCRE_VERSION = '0.6.0';

export interface HucreAssetSpec {
  /** Filename written into the plugin's hucre dir. */
  file: string;
  /** Absolute download URL (dependency-bundled ESM of `hucre/xlsx`). */
  url: string;
  /** Reject downloads smaller than this (guards against HTML error pages). */
  minBytes: number;
}

export const HUCRE_XLSX_ASSET: HucreAssetSpec = {
  file: 'hucre-xlsx.mjs',
  url: `https://esm.sh/hucre@${HUCRE_VERSION}/xlsx`,
  minBytes: 50_000,
};

/** The complete, deterministic set of files the write-back/mirror engine needs. */
export function buildHucreAssetManifest(): HucreAssetSpec[] {
  return [HUCRE_XLSX_ASSET];
}
