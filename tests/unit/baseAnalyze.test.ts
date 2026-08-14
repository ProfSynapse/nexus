/**
 * tests/unit/baseAnalyze.test.ts
 *
 * `base analyze` — executing a `.base` and reading the rows back.
 *
 * These lanes exist for the failures a green build and a live smoke run both
 * hide. The live loop proves the mechanism works against a real Obsidian; what
 * it cannot prove is that the mechanism still behaves when things go wrong,
 * because the interesting states (a stale view registration, a render that
 * never reports, a scratch file left behind by a throw) are all hard to
 * manufacture in a running app and trivial to manufacture here:
 *
 *   - the value serialiser never touches the `type` getter, whose invocation
 *     silently corrupts the live query result rather than throwing
 *   - `JSON.stringify` on a LinkValue/FileValue throws; the serialiser must not
 *   - a view with no `order` falls back to every property, instead of reporting
 *     the single `file.name` column Obsidian collapses to
 *   - the scratch file is deleted on the success path AND on the failure path
 *   - a render that never produces data times out with an actionable message
 *     rather than hanging
 *   - zero rows plus rendered text is a broken base, NOT "no matches"
 */

import { MarkdownRenderer, TFile } from 'obsidian';
import {
    ANALYZE_PROTOCOL_INERT,
    ensureAnalyzeViewRegistered,
    awaitAnalyzeView,
    refreshAnalyzeViewRegistration,
    resetAnalyzeViewRegistrationRecord,
    NEXUS_ANALYZE_VIEW_ID
} from '@/agents/baseManager/services/basesAvailability';
import { serializeValue } from '@/agents/baseManager/services/baseValueSerializer';
import { harvestView } from '@/agents/baseManager/services/baseResultHarvester';
import { BaseAnalyzeError, BaseQueryRunner } from '@/agents/baseManager/services/BaseQueryRunner';
import { SCRATCH_PREFIX } from '@/agents/baseManager/services/BaseFileOperations';
import { AnalyzeBaseTool, DEFAULT_ANALYZE_LIMIT, MAX_ANALYZE_LIMIT } from '@/agents/baseManager/tools/analyze';
import type { App, BasesView, Plugin } from 'obsidian';

// ── Fakes ───────────────────────────────────────────────────────────────────

/** A stand-in for a Bases `Value`: `static type` on the class, `toString` on the instance. */
function fakeValue(type: string | undefined, display: string, extra: Record<string, unknown> = {}) {
    class FakeValue {
        static type = type;
        toString(): string {
            return display;
        }
    }
    return Object.assign(new FakeValue(), extra);
}

function fakeEntry(path: string, values: Record<string, unknown>) {
    return {
        file: { path } as unknown as TFile,
        getValue: (property: string) => (property in values ? values[property] : null)
    };
}

function pluginWith(registerBasesView?: jest.Mock): Plugin {
    return (registerBasesView ? { registerBasesView } : {}) as unknown as Plugin;
}

/** A live-view registration recorded at the current protocol version. */
function registerLiveView(): void {
    resetAnalyzeViewRegistrationRecord();
    expect(ensureAnalyzeViewRegistered(pluginWith(jest.fn().mockReturnValue(true)))).toBe(true);
}

interface FakeHost {
    textContent: string;
    detach: jest.Mock;
}

/**
 * Replace the node-env `createDiv` stub with one that has the surface the
 * runner uses (`textContent`, `detach`), and hand the host back so a test can
 * put text in it the way Obsidian would.
 */
function installHost(text = ''): FakeHost {
    const host: FakeHost = { textContent: text, detach: jest.fn() };
    (window.activeDocument.body.createDiv as jest.Mock).mockReturnValue(host);
    return host;
}

function makeApp(files: Record<string, string>) {
    const entries = new Map<string, TFile>();
    for (const path of Object.keys(files)) {
        const file = new TFile(path.split('/').pop() ?? path, path);
        (file as unknown as { stat: { mtime: number } }).stat = { mtime: Date.now() };
        entries.set(path, file);
    }

    const vault = {
        create: jest.fn().mockImplementation((path: string, content: string) => {
            files[path] = content;
            const file = new TFile(path.split('/').pop() ?? path, path);
            (file as unknown as { stat: { mtime: number } }).stat = { mtime: Date.now() };
            entries.set(path, file);
            return Promise.resolve(file);
        }),
        read: jest.fn().mockImplementation((file: TFile) => Promise.resolve(files[file.path])),
        getAbstractFileByPath: jest.fn().mockImplementation((path: string) => entries.get(path)),
        getFiles: jest.fn().mockImplementation(() => Array.from(entries.values())),
        getMarkdownFiles: jest.fn().mockReturnValue([]),
        adapter: {
            exists: jest.fn().mockImplementation((path: string) => Promise.resolve(path in files)),
            remove: jest.fn().mockImplementation((path: string) => {
                delete files[path];
                entries.delete(path);
                return Promise.resolve();
            })
        }
    };

    const app = {
        vault,
        metadataCache: { getFileCache: jest.fn().mockReturnValue(undefined) }
    } as unknown as App;

    return { app, vault, files };
}

/**
 * Drive Obsidian's half of the rendezvous: on render, hand `view` to whatever
 * sink the runner registered. Deliberately reached through the FROZEN
 * `globalThis` symbol rather than through an import, because that symbol is the
 * actual contract between a registered view and a possibly-newer runner.
 */
function renderCallsSinkWith(view: unknown): void {
    (MarkdownRenderer.render as jest.Mock).mockImplementation(async () => {
        const sinks = (window as unknown as Record<symbol, Map<string, (v: unknown) => void>>)[
            Symbol.for('nexus:bases-analyze-sinks')
        ];
        for (const sink of sinks.values()) sink(view);
    });
}

const BASE_CONFIG = {
    filters: { and: ['file.hasTag("task")'] },
    formulas: { days_left: 'if(due, 1, "")' },
    views: [
        { type: 'table', name: 'Active', order: ['file.name', 'note.status'] },
        { type: 'table', name: 'Bare' }
    ]
};

beforeEach(() => {
    (MarkdownRenderer.render as jest.Mock).mockReset();
    (MarkdownRenderer.render as jest.Mock).mockResolvedValue(undefined);
    resetAnalyzeViewRegistrationRecord();
});

afterAll(() => {
    resetAnalyzeViewRegistrationRecord();
});

// ── Value serialisation ─────────────────────────────────────────────────────

describe('serializeValue', () => {
    it('NEVER reads the instance `type` getter, which corrupts the value in place', () => {
        let touched = 0;
        class Trap {
            static type = 'string';
            get type(): unknown {
                touched++;
                // The real getter returns this.constructor, and calling that
                // re-runs the constructor over the live value.
                return Trap;
            }
            toString(): string {
                return 'intact';
            }
        }

        expect(serializeValue(new Trap() as never)).toBe('intact');
        expect(touched).toBe(0);
    });

    it('serialises a value JSON.stringify would throw on (circular via app)', () => {
        const circular = fakeValue('Link', '[[bravo]]');
        (circular as unknown as { app: unknown }).app = { self: circular };

        expect(() => JSON.stringify(circular)).toThrow();
        expect(serializeValue(circular as never)).toBe('[[bravo]]');
    });

    it('recovers numbers and booleans, and keeps everything else as its display string', () => {
        // The shipped app spells these capitalised ('Number', 'Null', …), which
        // is what this file matches against; the lowercase spellings a reader
        // would guess from the API docs must keep working too.
        expect(serializeValue(fakeValue('Number', '3') as never)).toBe(3);
        expect(serializeValue(fakeValue('number', '3') as never)).toBe(3);
        expect(serializeValue(fakeValue('Boolean', 'true') as never)).toBe(true);
        expect(serializeValue(fakeValue('Date', '2026-08-20') as never)).toBe('2026-08-20');
        expect(serializeValue(fakeValue('Link', '[[bravo]]') as never)).toBe('[[bravo]]');
        expect(serializeValue(null)).toBeNull();
    });

    it('turns a NullValue into null, never into the string "null"', () => {
        // A property the note does not have arrives as a NullValue whose
        // toString() is literally "null" — the one case where falling back to
        // the display string would put a lie in the row.
        expect(serializeValue(fakeValue('Null', 'null') as never)).toBeNull();
    });

    it('expands a list into an array, by type or by structure', () => {
        const items = [fakeValue('String', 'a'), fakeValue('Number', '2')];
        const list = fakeValue('List', 'a, 2', {
            length: () => items.length,
            get: (index: number) => items[index]
        });
        expect(serializeValue(list as never)).toEqual(['a', 2]);

        // Same object with no usable static type: the structural fallback still
        // recognises it rather than flattening it to a string.
        const untyped = fakeValue(undefined, 'a, 2', {
            length: () => items.length,
            get: (index: number) => items[index]
        });
        expect(serializeValue(untyped as never)).toEqual(['a', 2]);
    });

    it('degrades one bad cell instead of failing the query', () => {
        const hostile = fakeValue('String', '', {
            toString: () => {
                throw new Error('nope');
            }
        });
        expect(serializeValue(hostile as never)).toBe('');
    });
});

// ── Harvesting ──────────────────────────────────────────────────────────────

describe('harvestView', () => {
    const entries = [
        fakeEntry('A/alpha.md', { 'file.name': fakeValue('String', 'alpha'), 'note.status': fakeValue('String', 'todo'), 'note.priority': fakeValue('Number', '2') }),
        fakeEntry('A/bravo.md', { 'file.name': fakeValue('String', 'bravo'), 'note.status': fakeValue('String', 'done'), 'note.priority': fakeValue('Number', '1') })
    ];

    function viewWith(overrides: Record<string, unknown> = {}): BasesView {
        return {
            allProperties: ['file.name', 'note.status', 'note.priority'],
            data: {
                properties: ['file.name', 'note.status'],
                data: entries,
                groupedData: [
                    { hasKey: () => true, key: fakeValue('String', 'todo'), entries: [entries[0]] },
                    { hasKey: () => true, key: fakeValue('String', 'done'), entries: [entries[1]] }
                ],
                getSummaryValue: jest.fn().mockReturnValue(fakeValue('Number', '3'))
            },
            nexusController: {},
            ...overrides
        } as unknown as BasesView;
    }

    it('returns the declared columns, and always carries file.path', () => {
        const result = harvestView(viewWith(), { declaredOrder: ['file.name', 'status'], limit: 10 });

        expect(result.propertiesSource).toBe('view');
        expect(result.properties).toEqual(['file.name', 'note.status']);
        expect(result.rows?.[0]).toEqual({ 'file.path': 'A/alpha.md', 'file.name': 'alpha', 'note.status': 'todo' });
        expect(result.rowCount).toBe(2);
        expect(result.truncated).toBe(false);
    });

    it('falls back to every property when the view declares no order', () => {
        // Obsidian collapses `properties` to just file.name here, which reads as
        // "this base has one column" and is really "the user chose none".
        const view = viewWith({ data: { ...viewWith().data, properties: ['file.name'] } });
        const result = harvestView(view, { limit: 10 });

        expect(result.propertiesSource).toBe('allProperties');
        expect(result.properties).toEqual(['file.name', 'note.status', 'note.priority']);
    });

    it('never returns the scratch file as one of its own rows', () => {
        // A base that matches by folder or extension matches the scratch .base
        // sitting next to the source. Counting it would report a file that does
        // not exist and a rowCount one too high.
        const withScratch = viewWith({
            data: {
                ...viewWith().data,
                data: [...entries, fakeEntry('A/__nexus-analyze-x.base', {})],
                groupedData: [{ hasKey: () => false, entries: [...entries, fakeEntry('A/__nexus-analyze-x.base', {})] }]
            }
        });

        const flat = harvestView(withScratch, { declaredOrder: ['file.name'], limit: 10, excludePath: 'A/__nexus-analyze-x.base' });
        expect(flat.rowCount).toBe(2);
        expect(flat.rows?.map(row => row['file.path'])).toEqual(['A/alpha.md', 'A/bravo.md']);

        const grouped = harvestView(withScratch, { declaredGroupBy: true, declaredOrder: ['file.name'], limit: 10, excludePath: 'A/__nexus-analyze-x.base' });
        expect(grouped.groups?.[0].rowCount).toBe(2);
    });

    it('bounds rows without lying about how many matched', () => {
        const result = harvestView(viewWith(), { declaredOrder: ['file.name'], limit: 1 });

        expect(result.rowCount).toBe(2);
        expect(result.returned).toBe(1);
        expect(result.truncated).toBe(true);
    });

    it('nests rows in groups only when the view declares groupBy', () => {
        const flat = harvestView(viewWith(), { declaredOrder: ['file.name'], limit: 10 });
        expect(flat.grouped).toBe(false);
        expect(flat.groups).toBeUndefined();

        const grouped = harvestView(viewWith(), { declaredOrder: ['file.name'], declaredGroupBy: true, limit: 10 });
        expect(grouped.grouped).toBe(true);
        expect(grouped.groups?.map(group => group.key)).toEqual(['todo', 'done']);
        expect(grouped.rows).toBeUndefined();
        expect(grouped.returned).toBe(2);
    });

    it('spends the row budget across groups instead of per group', () => {
        const grouped = harvestView(viewWith(), { declaredGroupBy: true, declaredOrder: ['file.name'], limit: 1 });

        expect(grouped.returned).toBe(1);
        expect(grouped.groups?.[0].rows).toHaveLength(1);
        expect(grouped.groups?.[1].rows).toHaveLength(0);
        // The empty group still reports what it holds, so nothing vanishes.
        expect(grouped.groups?.[1].rowCount).toBe(1);
    });

    it('prefixes a bare summary property to a property id, and survives a summary that throws', () => {
        const view = viewWith();
        const result = harvestView(view, { declaredOrder: ['file.name'], declaredSummaries: { priority: 'Sum' }, limit: 10 });

        expect(view.data.getSummaryValue).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'note.priority', 'Sum');
        expect(result.summaries).toEqual({ 'note.priority': { Sum: 3 } });

        const throwing = viewWith({
            data: {
                ...viewWith().data,
                getSummaryValue: jest.fn().mockImplementation(() => {
                    throw new Error('unknown summary');
                })
            }
        });
        expect(harvestView(throwing, { declaredSummaries: { priority: 'Sum' }, limit: 10 }).summaries).toBeUndefined();
    });
});

// ── Registration repair ─────────────────────────────────────────────────────

describe('refreshAnalyzeViewRegistration', () => {
    function appWithRegistrations(table: Record<string, unknown> | null, enabled = true): App {
        return {
            internalPlugins: { plugins: { bases: { enabled, instance: table ? { registrations: table } : {} } } }
        } as unknown as App;
    }

    it('re-registers when a Bases off→on toggle wiped the view type', () => {
        registerLiveView();
        const register = jest.fn().mockReturnValue(true);

        // Bases' table no longer holds our id: the record is a lie.
        expect(refreshAnalyzeViewRegistration(appWithRegistrations({}), pluginWith(register))).toBe(1);
        expect(register).toHaveBeenCalledTimes(1);
    });

    it('does not re-register when the view type is still live (a duplicate shows a Notice)', () => {
        registerLiveView();
        const register = jest.fn().mockReturnValue(true);

        const table = { [NEXUS_ANALYZE_VIEW_ID]: {} };
        expect(refreshAnalyzeViewRegistration(appWithRegistrations(table), pluginWith(register))).toBe(1);
        expect(register).not.toHaveBeenCalled();
    });

    it('assumes live when Obsidian internals are unrecognisable', () => {
        registerLiveView();
        const register = jest.fn().mockReturnValue(true);

        expect(refreshAnalyzeViewRegistration({} as App, pluginWith(register))).toBe(1);
        expect(register).not.toHaveBeenCalled();
    });

    it('reports a Phase 1 registration as inert rather than waiting on it forever', () => {
        // Exactly what an in-place plugin update leaves behind: the older build
        // recorded a bare Set of ids and registered a view that never reports.
        resetAnalyzeViewRegistrationRecord();
        (window as unknown as Record<symbol, unknown>)[Symbol.for('nexus:bases-view-registrations')] =
            new Set([NEXUS_ANALYZE_VIEW_ID]);

        const register = jest.fn().mockReturnValue(true);
        const table = { [NEXUS_ANALYZE_VIEW_ID]: {} };
        expect(refreshAnalyzeViewRegistration(appWithRegistrations(table), pluginWith(register))).toBe(ANALYZE_PROTOCOL_INERT);
        expect(register).not.toHaveBeenCalled();
    });
});

describe('awaitAnalyzeView', () => {
    it('resolves on the first update and stops listening after dispose', async () => {
        const rendezvous = awaitAnalyzeView('nexus-analyze-x');
        const sinks = (window as unknown as Record<symbol, Map<string, (v: unknown) => void>>)[
            Symbol.for('nexus:bases-analyze-sinks')
        ];

        sinks.get('nexus-analyze-x')?.({ marker: 1 });
        await expect(rendezvous.view).resolves.toEqual({ marker: 1 });

        rendezvous.dispose();
        expect(sinks.has('nexus-analyze-x')).toBe(false);
    });
});

// ── The runner ──────────────────────────────────────────────────────────────

describe('BaseQueryRunner.selectView', () => {
    it('defaults to the first view', () => {
        expect(BaseQueryRunner.selectView(BASE_CONFIG).name).toBe('Active');
    });

    it('matches case-insensitively', () => {
        expect(BaseQueryRunner.selectView(BASE_CONFIG, 'active').name).toBe('Active');
    });

    it('says which views exist rather than returning nothing', () => {
        expect(() => BaseQueryRunner.selectView(BASE_CONFIG, 'Nope')).toThrow(/Views in this base: Active, Bare/);
    });

    it('rejects a base with no views', () => {
        expect(() => BaseQueryRunner.selectView({ views: [] })).toThrow(BaseAnalyzeError);
    });
});

describe('BaseQueryRunner.run', () => {
    const harvestable = {
        allProperties: ['file.name'],
        data: {
            properties: ['file.name'],
            data: [fakeEntry('A/alpha.md', { 'file.name': fakeValue('String', 'alpha') })],
            groupedData: [],
            getSummaryValue: jest.fn()
        },
        nexusController: {}
    };

    it('renders an embed of a scratch base, harvests, and deletes the scratch file', async () => {
        registerLiveView();
        installHost();
        renderCallsSinkWith(harvestable);
        const { app, vault, files } = makeApp({ 'A/Tasks.base': 'x' });

        const result = await BaseQueryRunner.run({
            app,
            plugin: pluginWith(jest.fn().mockReturnValue(true)),
            sourcePath: 'A/Tasks.base',
            config: BASE_CONFIG,
            viewName: 'Active',
            limit: 10
        });

        expect(result.harvest.rows).toEqual([{ 'file.path': 'A/alpha.md', 'file.name': 'alpha' }]);
        expect(result.view).toEqual({ name: 'Active', type: 'table' });

        // The scratch file is a SIBLING of the source base, and the embed points
        // at it with the view name as the subpath.
        const created = (vault.create as jest.Mock).mock.calls[0][0] as string;
        expect(created.startsWith(`A/${SCRATCH_PREFIX}`)).toBe(true);
        const [, markdown, , sourcePath] = (MarkdownRenderer.render as jest.Mock).mock.calls[0] as string[];
        expect(markdown).toBe(`![[${created}#${NEXUS_ANALYZE_VIEW_ID}-${created.slice(`A/${SCRATCH_PREFIX}`.length, -'.base'.length)}]]`);
        // sourcePath is the ORIGINAL base, so links and `this` resolve as they would there.
        expect(sourcePath).toBe('A/Tasks.base');

        // The scratch config keeps the file's own sections and carries exactly
        // one view, of our type — the requested view, retyped.
        const scratch = (vault.create as jest.Mock).mock.calls[0][1] as string;
        expect(scratch).toContain(NEXUS_ANALYZE_VIEW_ID);
        expect(scratch).toContain('days_left');

        expect(vault.adapter.remove).toHaveBeenCalledWith(created);
        expect(files[created]).toBeUndefined();
    });

    it('deletes the scratch file even when the render never reports', async () => {
        registerLiveView();
        installHost('Base file not found');
        const { app, vault, files } = makeApp({ 'A/Tasks.base': 'x' });

        await expect(
            BaseQueryRunner.run({
                app,
                plugin: pluginWith(jest.fn().mockReturnValue(true)),
                sourcePath: 'A/Tasks.base',
                config: BASE_CONFIG,
                limit: 10,
                timeoutMs: 20
            })
        ).rejects.toThrow(/did not produce results within 20 ms.*Base file not found/s);

        const created = (vault.create as jest.Mock).mock.calls[0][0] as string;
        expect(files[created]).toBeUndefined();
        expect(vault.adapter.remove).toHaveBeenCalledWith(created);
    });

    it('refuses to wait on a view registered by an older Nexus', async () => {
        resetAnalyzeViewRegistrationRecord();
        (window as unknown as Record<symbol, unknown>)[Symbol.for('nexus:bases-view-registrations')] =
            new Set([NEXUS_ANALYZE_VIEW_ID]);
        installHost();
        const { app, vault } = makeApp({ 'A/Tasks.base': 'x' });

        await expect(
            BaseQueryRunner.run({
                app,
                plugin: pluginWith(jest.fn().mockReturnValue(true)),
                sourcePath: 'A/Tasks.base',
                config: BASE_CONFIG,
                limit: 10
            })
        ).rejects.toThrow(/restart Obsidian/);

        // Nothing was written: the failure is detected before any vault work.
        expect(vault.create).not.toHaveBeenCalled();
    });

    it('sweeps a scratch file an earlier crash left behind, but not a fresh one', async () => {
        const { app, vault } = makeApp({
            [`A/${SCRATCH_PREFIX}old.base`]: 'x',
            [`A/${SCRATCH_PREFIX}new.base`]: 'x'
        });
        const files = (vault.getFiles as jest.Mock)() as TFile[];
        (files[0] as unknown as { stat: { mtime: number } }).stat.mtime = Date.now() - 10 * 60_000;

        expect(await BaseQueryRunner.sweepStaleScratchFiles(app)).toBe(1);
        expect(vault.adapter.remove).toHaveBeenCalledWith(`A/${SCRATCH_PREFIX}old.base`);
        expect(vault.adapter.remove).not.toHaveBeenCalledWith(`A/${SCRATCH_PREFIX}new.base`);
    });
});

// ── The tool ────────────────────────────────────────────────────────────────

describe('base analyze', () => {
    const BASE_YAML = 'views:\n  - type: table\n    name: Active\n    order:\n      - file.name\n';

    function toolWith(app: App) {
        return new AnalyzeBaseTool(app, pluginWith(jest.fn().mockReturnValue(true)));
    }

    function runReturns(overrides: Record<string, unknown> = {}) {
        return jest.spyOn(BaseQueryRunner, 'run').mockResolvedValue({
            view: { name: 'Active', type: 'table' },
            harvest: {
                properties: ['file.name'],
                propertiesSource: 'view',
                propertiesTruncated: false,
                rowCount: 2,
                returned: 2,
                truncated: false,
                grouped: false,
                rows: [{ 'file.path': 'A/alpha.md' }]
            },
            renderText: '',
            elapsedMs: 90,
            ...overrides
        } as never);
    }

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('requires a path', async () => {
        const { app } = makeApp({});
        const result = await toolWith(app).execute({ path: '  ' } as never);
        expect(result.success).toBe(false);
        expect(result.error).toContain('path is required');
    });

    it('defaults and clamps the row limit rather than trusting the schema', async () => {
        const { app } = makeApp({ 'A/Tasks.base': BASE_YAML });
        const run = runReturns();

        await toolWith(app).execute({ path: 'A/Tasks' } as never);
        expect((run.mock.calls[0][0] as { limit: number }).limit).toBe(DEFAULT_ANALYZE_LIMIT);

        await toolWith(app).execute({ path: 'A/Tasks', limit: 99999 } as never);
        expect((run.mock.calls[1][0] as { limit: number }).limit).toBe(MAX_ANALYZE_LIMIT);

        // A CLI hands strings through; a nonsense one must be rejected, not coerced to 0.
        await toolWith(app).execute({ path: 'A/Tasks', limit: '5' } as never);
        expect((run.mock.calls[2][0] as { limit: number }).limit).toBe(5);

        const bad = await toolWith(app).execute({ path: 'A/Tasks', limit: 'lots' } as never);
        expect(bad.success).toBe(false);
        expect(bad.error).toMatch(/limit must be a number/);
    });

    it('returns zero rows as an empty result AND warns that empty has two meanings', async () => {
        // Verified against Obsidian 1.13.7: a filter Bases cannot evaluate and a
        // filter that matches nothing produce byte-identical DOM, no console
        // output and no error anywhere in the API. Failing the call would make
        // every legitimately empty base look broken, so the ambiguity is
        // reported instead of guessed at.
        const { app } = makeApp({ 'A/Tasks.base': BASE_YAML });
        runReturns({
            harvest: {
                properties: ['file.name'],
                propertiesSource: 'view',
                propertiesTruncated: false,
                rowCount: 0,
                returned: 0,
                truncated: false,
                grouped: false,
                rows: []
            },
            renderText: 'resultsSort0Filter1PropertiesSearchNewShowing 0'
        });

        const result = await toolWith(app).execute({ path: 'A/Tasks' } as never);

        expect(result.success).toBe(true);
        expect(result.data?.rowCount).toBe(0);
        expect(result.data?.warnings?.some(warning => warning.includes('cannot evaluate a filter'))).toBe(true);
        // The Bases toolbar chrome is on every render, healthy or not, so it is
        // never echoed into the result.
        expect(JSON.stringify(result)).not.toContain('resultsSort0Filter1');
    });

    it('does not warn about the empty-result ambiguity when rows came back', async () => {
        const { app } = makeApp({ 'A/Tasks.base': BASE_YAML });
        runReturns();

        const result = await toolWith(app).execute({ path: 'A/Tasks' } as never);
        expect(result.success).toBe(true);
        expect(result.data?.warnings).toBeUndefined();
    });

    it('warns that `this` means something different under an embed', async () => {
        const { app } = makeApp({ 'A/Tasks.base': 'filters: this.file.folder\nviews:\n  - type: table\n    name: Active\n' });
        runReturns();

        const result = await toolWith(app).execute({ path: 'A/Tasks' } as never);
        expect(result.success).toBe(true);
        expect(result.data?.warnings?.[0]).toMatch(/`this`/);
    });

    it('surfaces an unparseable base as a refusal to execute it', async () => {
        const { app } = makeApp({ 'A/Tasks.base': 'views: [oops\n  - broken' });
        const result = await toolWith(app).execute({ path: 'A/Tasks' } as never);

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not valid YAML/);
    });
});
