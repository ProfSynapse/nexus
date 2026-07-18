/**
 * Unit tests for the nexus CLI playbook helpers (cli/playbooks.ts):
 * frontmatter parsing + on-disk listing. Pure, no socket/vault needed.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter, listPlaybooks, playbooksDir } from '../../cli/playbooks';

describe('parseFrontmatter', () => {
    it('extracts name, intent, and the tools array', () => {
        const raw = [
            '---',
            'name: vault-work',
            'intent: Search then edit notes',
            'tools: [search content, content read, content write]',
            '---',
            '# Body',
            'protocol here',
        ].join('\n');
        const { meta, body } = parseFrontmatter(raw);
        expect(meta.name).toBe('vault-work');
        expect(meta.intent).toBe('Search then edit notes');
        expect(meta.tools).toEqual(['search content', 'content read', 'content write']);
        expect(body.trim()).toBe('# Body\nprotocol here');
    });

    it('strips surrounding quotes on intent/name', () => {
        const { meta } = parseFrontmatter('---\nname: "x"\nintent: \'has: colon\'\ntools: []\n---\nb');
        expect(meta.name).toBe('x');
        expect(meta.intent).toBe('has: colon');
        expect(meta.tools).toEqual([]);
    });

    it('handles CRLF line endings', () => {
        const raw = '---\r\nname: tasks\r\nintent: DAG\r\ntools: [task create]\r\n---\r\nbody';
        const { meta, body } = parseFrontmatter(raw);
        expect(meta.name).toBe('tasks');
        expect(meta.tools).toEqual(['task create']);
        expect(body).toContain('body');
    });

    it('returns empty meta and full body when there is no frontmatter', () => {
        const { meta, body } = parseFrontmatter('no frontmatter here');
        expect(meta).toEqual({ name: '', intent: '', tools: [] });
        expect(body).toBe('no frontmatter here');
    });

    it('parses a multi-word tools array with mixed spacing', () => {
        const { meta } = parseFrontmatter('---\nname: n\nintent: i\ntools: [a b,  c d ,e]\n---\n');
        expect(meta.tools).toEqual(['a b', 'c d', 'e']);
    });
});

describe('listPlaybooks', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nexus-pb-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('lists .md playbooks, excludes _-prefixed and non-md, sorted by presence', () => {
        writeFileSync(join(dir, 'vault-work.md'), '---\nname: vault-work\nintent: A\ntools: []\n---\n');
        writeFileSync(join(dir, 'tasks.md'), '---\nname: tasks\nintent: B\ntools: []\n---\n');
        writeFileSync(join(dir, '_preamble.md'), '# spine');            // excluded (underscore)
        writeFileSync(join(dir, 'README.txt'), 'not markdown');          // excluded (not .md)
        const names = listPlaybooks(dir).map((m) => m.name).sort();
        expect(names).toEqual(['tasks', 'vault-work']);
    });

    it('drops files whose frontmatter has no name', () => {
        writeFileSync(join(dir, 'good.md'), '---\nname: good\nintent: X\ntools: []\n---\n');
        writeFileSync(join(dir, 'bad.md'), 'no frontmatter, no name');
        expect(listPlaybooks(dir).map((m) => m.name)).toEqual(['good']);
    });

    it('returns [] for a missing directory', () => {
        expect(listPlaybooks(join(dir, 'does-not-exist'))).toEqual([]);
    });
});

describe('playbooksDir', () => {
    const saved = process.env.NEXUS_PLAYBOOKS_DIR;
    afterEach(() => {
        if (saved === undefined) delete process.env.NEXUS_PLAYBOOKS_DIR;
        else process.env.NEXUS_PLAYBOOKS_DIR = saved;
    });

    it('honors the NEXUS_PLAYBOOKS_DIR override', () => {
        process.env.NEXUS_PLAYBOOKS_DIR = '/custom/pb';
        expect(playbooksDir()).toBe('/custom/pb');
    });

    it('falls back to <dataDir>/skill/playbooks under the home data dir', () => {
        delete process.env.NEXUS_PLAYBOOKS_DIR;
        expect(playbooksDir()).toMatch(/[\\/]skill[\\/]playbooks$/);
    });
});
