/**
 * `BasesView` must never be dereferenced at module load.
 *
 * `src/agents/baseManager/services/basesAvailability.ts` imports `BasesView`
 * from 'obsidian' as a VALUE, and `BasesView` is `@since 1.10.0` — newer than
 * the manifest's `minAppVersion` of 1.8.7. That is only safe because esbuild
 * emits `obsidian` as an external CJS require, so the binding resolves as a
 * property access (`import_obsidian.BasesView`) at call time, inside
 * `createAnalyzeView`, rather than when the module is evaluated. On an Obsidian
 * without the Bases API the property is simply never read.
 *
 * The whole guarantee therefore rests on the emitted shape, not on the source.
 * Change `format` away from `cjs`, or hoist the `class ... extends BasesView`
 * out of its factory, and this silently becomes a top-level dereference of
 * `undefined` — a load-time crash for every user on an Obsidian that predates
 * Bases, from a diff that looks like a build-config tidy-up. Nothing else in the
 * toolchain notices: tsc and eslint both see a perfectly ordinary import.
 *
 * These tests bundle the real module the way the real build does, then evaluate
 * it against an 'obsidian' stub that throws if anything touches `BasesView`.
 *
 * Known limit, found by mutation-testing this file: esbuild tree-shakes a
 * hoisted class that nothing reaches, so `class X extends BasesView {}` added at
 * module scope and never used does NOT trip these tests — it never reaches the
 * bundle. Only a *reachable* top-level dereference is caught. That is the shape
 * a real regression has (the class is returned by the factory, so it is kept),
 * but do not read a green run here as "no post-1.8.7 symbol is used eagerly".
 */
import * as esbuild from 'esbuild';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MODULE_UNDER_TEST = 'src/agents/baseManager/services/basesAvailability.ts';

/** Bundle one module exactly as esbuild.config.mjs bundles the plugin. */
async function bundle(entryPoint: string, stdin?: { contents: string }): Promise<string> {
    const result = await esbuild.build({
        ...(stdin
            ? { stdin: { ...stdin, resolveDir: REPO_ROOT, loader: 'ts' as const } }
            : { entryPoints: [entryPoint] }),
        absWorkingDir: REPO_ROOT,
        bundle: true,
        write: false,
        format: 'cjs',
        platform: 'node',
        // Same externals that matter here: 'obsidian' is provided by the host.
        external: ['obsidian', 'electron'],
        logLevel: 'silent',
    });
    return result.outputFiles[0].text;
}

/**
 * An 'obsidian' module whose `BasesView` is a tripwire: reading it throws.
 * Everything else answers undefined, which is enough for module evaluation.
 */
function obsidianWithoutBases(): { module: unknown; reads: string[] } {
    const reads: string[] = [];
    const module = new Proxy(
        {},
        {
            get(_target, prop) {
                const name = String(prop);
                if (name === 'BasesView') {
                    reads.push(name);
                    throw new Error('BasesView was dereferenced at module load');
                }
                // Jest/CJS interop probes these; answering undefined is correct.
                return undefined;
            },
        }
    );
    return { module, reads };
}

/** Evaluate CJS source with a controlled `require`, returning what it exported. */
function evaluateCjs(code: string, obsidian: unknown): unknown {
    const module = { exports: {} as Record<string, unknown> };
    const require = (specifier: string): unknown => {
        if (specifier === 'obsidian') return obsidian;
        throw new Error(`unexpected require(${specifier}) — the bundle should be self-contained`);
    };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function('require', 'module', 'exports', code);
    factory(require, module, module.exports);
    return module.exports;
}

describe('BasesView is bound lazily, not at module load', () => {
    // Bundling the real module is the slow part; do it once.
    let realBundle: string;

    beforeAll(async () => {
        realBundle = await bundle(MODULE_UNDER_TEST);
    }, 60_000);

    it('the tripwire is armed — reading BasesView on the stub throws', () => {
        const { module } = obsidianWithoutBases();
        expect(() => (module as Record<string, unknown>).BasesView).toThrow(
            /dereferenced at module load/
        );
    });

    it('catches a top-level dereference, so this test can fail', async () => {
        // A module shaped the way the regression would look: the class escapes
        // its factory and is evaluated when the module is.
        const regression = await bundle('', {
            contents: `
                import { BasesView } from 'obsidian';
                export class Hoisted extends BasesView {}
            `,
        });
        const { module } = obsidianWithoutBases();

        expect(() => evaluateCjs(regression, module)).toThrow(/dereferenced at module load/);
    });

    it('the real module evaluates on an Obsidian with no Bases API', () => {
        const { module, reads } = obsidianWithoutBases();

        expect(() => evaluateCjs(realBundle, module)).not.toThrow();
        expect(reads).toEqual([]);
    });

    it('still exports the analyze view id, so the module really was evaluated', () => {
        const { module } = obsidianWithoutBases();
        const exports = evaluateCjs(realBundle, module) as Record<string, unknown>;

        expect(exports.NEXUS_ANALYZE_VIEW_ID).toBe('nexus-analyze');
    });
});
