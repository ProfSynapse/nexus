/**
 * tests/unit/baseManagerTools.test.ts
 *
 * The four Phase 1/2 tools of the baseManager agent, against a fake vault.
 *
 * The behaviours that matter here are the ones a green build cannot show:
 *   - `update` replaces ONLY the sections supplied (a model editing one view
 *     must not be able to drop the user's others — the whole reason this
 *     differs from `canvas update`)
 *   - validation happens BEFORE the write, so a rejected call leaves the vault
 *     untouched
 *   - a rejection carries a structured issue list AND renders it into `error`,
 *     because the useTools failure path keeps nothing but `error`
 *   - a `..` path never reaches vault.create/modify
 */

import { TFile, stringifyYaml } from 'obsidian';
import { ReadBaseTool } from '@/agents/baseManager/tools/read';
import { WriteBaseTool } from '@/agents/baseManager/tools/write';
import { UpdateBaseTool } from '@/agents/baseManager/tools/update';
import { ListBaseTool } from '@/agents/baseManager/tools/list';
import { BaseManagerAgent } from '@/agents/baseManager/baseManager';
import type { BaseWriteResult } from '@/agents/baseManager/types';

interface FakeVault {
    create: jest.Mock;
    modify: jest.Mock;
    createFolder: jest.Mock;
    read: jest.Mock;
    getAbstractFileByPath: jest.Mock;
    getFiles: jest.Mock;
    getMarkdownFiles: jest.Mock;
}

function makeFile(path: string, mtime = 1): TFile {
    const file = new TFile(path.split('/').pop() ?? path, path);
    (file as unknown as { stat: { mtime: number } }).stat = { mtime };
    return file;
}

/** A vault holding `files` (path -> contents). */
function makeApp(files: Record<string, string> = {}, frontmatter: Record<string, unknown> = {}) {
    const entries = new Map<string, TFile>();
    for (const path of Object.keys(files)) {
        entries.set(path, makeFile(path));
    }

    const vault: FakeVault = {
        create: jest.fn().mockImplementation((path: string, content: string) => {
            files[path] = content;
            entries.set(path, makeFile(path));
            return Promise.resolve(entries.get(path));
        }),
        modify: jest.fn().mockImplementation((file: TFile, content: string) => {
            files[file.path] = content;
            return Promise.resolve();
        }),
        createFolder: jest.fn().mockResolvedValue(undefined),
        read: jest.fn().mockImplementation((file: TFile) => Promise.resolve(files[file.path])),
        getAbstractFileByPath: jest.fn().mockImplementation((path: string) => entries.get(path)),
        getFiles: jest.fn().mockImplementation(() => Array.from(entries.values())),
        getMarkdownFiles: jest.fn().mockReturnValue([makeFile('note.md')])
    };

    const app = {
        vault,
        metadataCache: { getFileCache: jest.fn().mockReturnValue({ frontmatter }) }
    } as unknown as import('obsidian').App;

    return { app, vault, files };
}

const TASK_BASE = stringifyYaml({
    filters: { and: ['file.hasTag("task")'] },
    formulas: { days_left: 'if(due, (date(due) - today()).days, "")' },
    views: [
        { type: 'table', name: 'Active', order: ['file.name', 'formula.days_left'] },
        { type: 'table', name: 'Done', filters: 'status == "done"', order: ['file.name'] }
    ]
});

describe('BaseManagerAgent registration', () => {
    it('registers four tools under the slugs the catalog advertises', () => {
        const { app } = makeApp();
        const agent = new BaseManagerAgent(app);
        expect(agent.name).toBe('baseManager');
        expect(agent.getTools().map((tool) => tool.slug).sort()).toEqual(['list', 'read', 'update', 'write']);
    });
});

describe('base read', () => {
    it('returns the parsed config with view and formula counts', async () => {
        const { app } = makeApp({ 'Tasks.base': TASK_BASE });
        const result = await new ReadBaseTool(app).execute({ path: 'Tasks' } as never);

        expect(result.success).toBe(true);
        expect(result.data?.path).toBe('Tasks.base');
        expect(result.data?.viewCount).toBe(2);
        expect(result.data?.formulaCount).toBe(1);
        expect(result.data?.viewNames).toEqual(['Active', 'Done']);
        expect(result.data?.config.filters).toEqual({ and: ['file.hasTag("task")'] });
    });

    it('fails with a usable message when the base does not exist', async () => {
        const { app } = makeApp();
        const result = await new ReadBaseTool(app).execute({ path: 'Missing.base' } as never);
        expect(result.success).toBe(false);
        expect(result.error).toContain('Base not found: Missing.base');
    });

    it('fails on a file that is not YAML', async () => {
        const { app } = makeApp({ 'Broken.base': 'views:\n  - type: table\n   name: x\n' });
        const result = await new ReadBaseTool(app).execute({ path: 'Broken.base' } as never);
        expect(result.success).toBe(false);
        expect(result.error).toContain('not valid YAML');
    });

    it('succeeds on a structurally invalid but parseable base, reporting the problems', async () => {
        const { app } = makeApp({ 'Odd.base': 'nonsense: 1\n' });
        const result = await new ReadBaseTool(app).execute({ path: 'Odd.base' } as never);
        expect(result.success).toBe(true);
        expect(result.data?.errors?.[0].code).toBe('unknown-key');
    });
});

describe('base list', () => {
    it('lists .base files with view/formula counts and ignores other files', async () => {
        const { app } = makeApp({
            'Tasks.base': TASK_BASE,
            'note.md': '# not a base',
            'Reading.base': stringifyYaml({ views: [{ type: 'cards', name: 'Library' }] })
        });

        const result = await new ListBaseTool(app).execute({} as never);

        expect(result.success).toBe(true);
        expect(result.data?.total).toBe(2);
        const tasks = result.data?.bases.find((base) => base.path === 'Tasks.base');
        expect(tasks).toMatchObject({ views: 2, formulas: 1, hasGlobalFilters: true });
        const reading = result.data?.bases.find((base) => base.path === 'Reading.base');
        expect(reading).toMatchObject({ views: 1, formulas: 0, hasGlobalFilters: false });
    });

    it('reports a broken base rather than failing the whole listing', async () => {
        const { app } = makeApp({ 'Broken.base': 'views:\n  - type: table\n   name: x\n' });
        const result = await new ListBaseTool(app).execute({} as never);
        expect(result.success).toBe(true);
        expect(result.data?.bases[0].error).toBeDefined();
    });
});

describe('base write', () => {
    it('creates a new base from a YAML config string', async () => {
        const { app, vault, files } = makeApp();
        const result = await new WriteBaseTool(app).execute({
            path: 'dashboards/Tasks',
            config: 'views:\n  - type: table\n    name: Active\n'
        } as never);

        expect(result.success).toBe(true);
        expect(vault.create).toHaveBeenCalledTimes(1);
        expect(result.data?.path).toBe('dashboards/Tasks.base');
        expect(files['dashboards/Tasks.base']).toContain('name: Active');
    });

    it('accepts sections as separate arguments, including JSON strings', async () => {
        const { app, files } = makeApp();
        const result = await new WriteBaseTool(app).execute({
            path: 'Tasks.base',
            filters: '{"and":["file.hasTag(\\"task\\")"]}',
            views: '[{"type":"table","name":"Active"}]'
        } as never);

        expect(result.success).toBe(true);
        expect(files['Tasks.base']).toContain('file.hasTag');
        expect(result.data?.sections).toEqual(['filters', 'views']);
    });

    it('fails when the base already exists, without modifying it', async () => {
        const { app, vault } = makeApp({ 'Tasks.base': TASK_BASE });
        const result = await new WriteBaseTool(app).execute({ path: 'Tasks.base' } as never);

        expect(result.success).toBe(false);
        expect(result.error).toContain('already exists');
        expect(vault.create).not.toHaveBeenCalled();
        expect(vault.modify).not.toHaveBeenCalled();
    });

    it('rejects an invalid config BEFORE writing, with structured errors', async () => {
        const { app, vault } = makeApp();
        const result = (await new WriteBaseTool(app).execute({
            path: 'Tasks.base',
            views: '[{"type":"table","name":"Active","order":["formula.missing"]}]'
        } as never)) as BaseWriteResult;

        expect(result.success).toBe(false);
        expect(vault.create).not.toHaveBeenCalled();
        expect(result.errors).toEqual([
            expect.objectContaining({ code: 'unknown-formula', path: 'views[0].order[0]' })
        ]);
        // The message must carry the same information: the useTools failure
        // path keeps `error` and drops every other field.
        expect(result.error).toContain('unknown-formula');
        expect(result.error).toContain('views[0].order[0]');
    });

    it('writes despite warnings, and returns them', async () => {
        const { app, vault } = makeApp();
        const result = (await new WriteBaseTool(app).execute({
            path: 'Tasks.base',
            formulas: '{"age":"(now() - file.ctime).round(0)"}',
            views: '[{"type":"nexus-analyze","name":"Headless"}]'
        } as never)) as BaseWriteResult;

        expect(result.success).toBe(true);
        expect(vault.create).toHaveBeenCalledTimes(1);
        expect(result.warnings?.map((issue) => issue.code).sort()).toEqual(['duration-arithmetic', 'unknown-view-type']);
    });

    it('creates a usable default when no content is supplied', async () => {
        const { app, files } = makeApp();
        const result = await new WriteBaseTool(app).execute({ path: 'Empty.base' } as never);
        expect(result.success).toBe(true);
        expect(files['Empty.base']).toContain('type: table');
    });

    it.each(['../../../../tmp/ESCAPE', '~/ESCAPE'])('rejects escaping path %s with no write', async (path) => {
        const { app, vault } = makeApp();
        const result = await new WriteBaseTool(app).execute({ path } as never);
        expect(result.success).toBe(false);
        expect(vault.create).not.toHaveBeenCalled();
    });
});

describe('base update', () => {
    it('replaces only the sections supplied and keeps the rest', async () => {
        const { app, files } = makeApp({ 'Tasks.base': TASK_BASE });
        const result = await new UpdateBaseTool(app).execute({
            path: 'Tasks.base',
            views: '[{"type":"table","name":"Only view","order":["file.name"]}]'
        } as never);

        expect(result.success).toBe(true);
        expect(result.data?.sections).toEqual(['views']);

        const written = files['Tasks.base'];
        expect(written).toContain('Only view');
        // The user's filters and formulas are still there — this is the whole
        // point of the merge, and where `canvas update` semantics would lose them.
        expect(written).toContain('file.hasTag("task")');
        expect(written).toContain('days_left');
    });

    it('fails when the base does not exist', async () => {
        const { app, vault } = makeApp();
        const result = await new UpdateBaseTool(app).execute({
            path: 'Missing.base',
            views: '[{"type":"table","name":"V"}]'
        } as never);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Base not found');
        expect(vault.modify).not.toHaveBeenCalled();
    });

    it('fails when nothing to update was supplied', async () => {
        const { app, vault } = makeApp({ 'Tasks.base': TASK_BASE });
        const result = await new UpdateBaseTool(app).execute({ path: 'Tasks.base' } as never);
        expect(result.success).toBe(false);
        expect(result.error).toContain('Nothing to update');
        expect(vault.modify).not.toHaveBeenCalled();
    });

    it('validates the MERGED config, not the fragment', async () => {
        // The fragment alone is fine; it is only invalid against the file it
        // lands in, because the removed formulas section defined days_left.
        const { app, vault } = makeApp({ 'Tasks.base': TASK_BASE });
        const result = (await new UpdateBaseTool(app).execute({
            path: 'Tasks.base',
            formulas: '{}'
        } as never)) as BaseWriteResult;

        expect(result.success).toBe(false);
        expect(vault.modify).not.toHaveBeenCalled();
        expect(result.errors?.[0]).toMatchObject({ code: 'unknown-formula', path: 'views[0].order[1]' });
    });

    it('refuses to touch a file that does not parse', async () => {
        const { app, vault } = makeApp({ 'Broken.base': 'views:\n  - type: table\n   name: x\n' });
        const result = await new UpdateBaseTool(app).execute({
            path: 'Broken.base',
            views: '[{"type":"table","name":"V"}]'
        } as never);

        expect(result.success).toBe(false);
        expect(result.error).toContain('not valid YAML');
        expect(vault.modify).not.toHaveBeenCalled();
    });

    it.each(['../../../../tmp/ESCAPE', '~/ESCAPE'])('rejects escaping path %s with no modify', async (path) => {
        const { app, vault } = makeApp();
        const result = await new UpdateBaseTool(app).execute({
            path,
            views: '[{"type":"table","name":"V"}]'
        } as never);
        expect(result.success).toBe(false);
        expect(vault.modify).not.toHaveBeenCalled();
    });
});
