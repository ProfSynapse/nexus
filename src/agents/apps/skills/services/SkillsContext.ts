/**
 * SkillsContext — resolves the Skills app's runtime pieces from the agent.
 *
 * Located at: src/agents/apps/skills/services/SkillsContext.ts
 * Centralizes the settings → storage-root → vault-adapter → SQLite-index
 * resolution that listSkills/loadSkill (and later CRUA tools) all need, so
 * each tool just calls resolveSkillsRuntime() and gets a friendly
 * {ok:false,error} at any missing piece — never a throw.
 * See docs/plans/skills-protocol-integration-plan.md §3 / §12.
 */

import { normalizePath } from 'obsidian';
import type { DataAdapter } from 'obsidian';
import { resolveVaultRoot } from '../../../../database/storage/VaultRootResolver';
import type { SQLiteCacheManager } from '../../../../database/storage/SQLiteCacheManager';
import { SkillIndexService } from './SkillIndexService';
import { SkillScanner } from './SkillScanner';
import type { SkillRecord } from '../types';
import type { SkillsAgent } from '../SkillsAgent';

export interface SkillsRuntime {
  /** Resolved `<root>/skills` mirror root (storage rootPath setting + "/skills"). */
  skillsRoot: string;
  vaultAdapter: DataAdapter;
  index: SkillIndexService;
  scanner: SkillScanner;
}

export type ResolveResult = { ok: true; rt: SkillsRuntime } | { ok: false; error: string };

/** Narrow structural type for the storage adapter's SQLite accessor. */
interface SqliteCacheProvider {
  getSqliteCache(): SQLiteCacheManager;
}

/**
 * Resolve the runtime pieces the Skills tools need. Returns a friendly error
 * at the first missing piece rather than throwing.
 */
export function resolveSkillsRuntime(agent: SkillsAgent): ResolveResult {
  const ctx = agent.getRuntimeContext();
  if (!ctx) {
    return { ok: false, error: 'Skills app runtime is not initialized' };
  }

  const settings = ctx.getSettings();
  const root = resolveVaultRoot({ storage: settings?.storage }).resolvedPath;
  const skillsRoot = normalizePath(`${root}/skills`);

  const vault = agent.getVault();
  if (!vault) {
    return { ok: false, error: 'Vault is not available' };
  }
  const vaultAdapter = vault.adapter;

  const adapter = ctx.getStorageAdapter();
  if (!adapter || !adapter.isReady()) {
    return { ok: false, error: 'Storage is still initializing — try again in a moment' };
  }

  if (typeof (adapter as Partial<SqliteCacheProvider>).getSqliteCache !== 'function') {
    return { ok: false, error: 'SQLite cache unavailable' };
  }
  const sqlite = (adapter as unknown as SqliteCacheProvider).getSqliteCache();

  const index = new SkillIndexService(sqlite);
  const scanner = new SkillScanner(vaultAdapter, skillsRoot);

  return { ok: true, rt: { skillsRoot, vaultAdapter, index, scanner } };
}

/** Result of resolving a (name, source?) to a single existing skill record. */
export type ResolveSkillResult =
  | { ok: true; record: SkillRecord }
  | { ok: false; error: string };

/**
 * Resolve a bare `name` (optionally scoped by `source` provider) to a single
 * existing skill record. Shared by updateSkill/archiveSkill so the
 * source/ambiguity handling lives in one place:
 *   - `source` given → exact (provider, name) lookup; error if missing.
 *   - no `source` → findByName; 0 → not-found error, 1 → use it,
 *     >1 → ambiguity error listing the candidate providers (no silent guess).
 */
export async function resolveSkillByName(
  index: SkillIndexService,
  name: string,
  source?: string
): Promise<ResolveSkillResult> {
  if (source) {
    const record = await index.getOne(source, name);
    if (!record) {
      return { ok: false, error: `No skill named "${name}" for provider "${source}"` };
    }
    return { ok: true, record };
  }

  const matches = await index.findByName(name);
  if (matches.length === 0) {
    return { ok: false, error: `No skill named "${name}"` };
  }
  if (matches.length > 1) {
    const providers = matches.map((m) => m.provider).join(', ');
    return {
      ok: false,
      error: `Skill "${name}" exists in multiple providers (${providers}); pass --source to disambiguate`,
    };
  }
  return { ok: true, record: matches[0] };
}
