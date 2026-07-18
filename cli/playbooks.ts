/**
 * Playbook helpers for the nexus CLI — pure, side-effect-free, unit-testable.
 *
 * Playbook markdown lives at <dataDir>/skill/playbooks/*.md, written by
 * LocalCliInstaller. These helpers locate that dir, parse frontmatter (no yaml
 * dep), and enumerate installed playbooks. The `playbook` command in
 * nexus-cli.ts composes them with live getTools/useTools calls.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PlaybookMeta { name: string; intent: string; tools: string[]; }

/**
 * Where the installed playbooks live. Recomputes <dataDir> exactly as
 * LocalCliInstaller.getPaths() does (NOT via __dirname, which Node resolves
 * through the ~/.local/bin/nexus symlink). NEXUS_PLAYBOOKS_DIR overrides for tests.
 */
export function playbooksDir(): string {
    if (process.env.NEXUS_PLAYBOOKS_DIR) return process.env.NEXUS_PLAYBOOKS_DIR;
    const home = homedir();
    const dataDir = process.platform === 'win32'
        ? join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'nexus')
        : join(home, '.local', 'share', 'nexus');
    return join(dataDir, 'skill', 'playbooks');
}

/** Parse `--- yaml --- body` frontmatter (only name/intent/tools; no yaml dep). */
export function parseFrontmatter(raw: string): { meta: PlaybookMeta; body: string } {
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    const meta: PlaybookMeta = { name: '', intent: '', tools: [] };
    if (!m) return { meta, body: raw };
    const fm = m[1];
    const nameM = fm.match(/^name:\s*(.+)$/m);
    if (nameM) meta.name = nameM[1].trim().replace(/^["']|["']$/g, '');
    const intentM = fm.match(/^intent:\s*(.+)$/m);
    if (intentM) meta.intent = intentM[1].trim().replace(/^["']|["']$/g, '');
    const toolsM = fm.match(/^tools:\s*\[([\s\S]*?)\]/m);
    if (toolsM) meta.tools = toolsM[1].split(',').map((s) => s.trim()).filter(Boolean);
    return { meta, body: m[2] };
}

/** List installed playbooks (excludes `_preamble.md` and other `_`-prefixed files). */
export function listPlaybooks(dir: string): PlaybookMeta[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
        .map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')).meta)
        .filter((m) => m.name);
}
