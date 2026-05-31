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
