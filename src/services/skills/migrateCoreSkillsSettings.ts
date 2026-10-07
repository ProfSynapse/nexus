import type { CoreSkillsSettings, ServiceResult } from '../instructions/types';
import type { AppConfig, AppsSettings } from '../../types/apps/AppTypes';

interface MigrationDocument { skills?: CoreSkillsSettings; apps?: AppsSettings }
interface MigrationStore {
  get(): MigrationDocument;
  apply(skills: CoreSkillsSettings | undefined, apps: AppsSettings): void;
  save(): Promise<void>;
}

/** Preserve explicit legacy enablement; core availability never depends on it. */
export function deriveCoreSkillsSettings(value: unknown, legacy?: AppConfig): CoreSkillsSettings {
  const current = value && typeof value === 'object' ? value as Partial<CoreSkillsSettings> : {};
  return {
    version: 1,
    automaticImport: typeof current.automaticImport === 'boolean' ? current.automaticImport : legacy?.enabled === true,
    syncBackOnEdit: typeof current.syncBackOnEdit === 'boolean' ? current.syncBackOnEdit : legacy?.enabled === true,
    legacyMigrationComplete: current.legacyMigrationComplete === true,
  };
}

/** Caller serializes settings writes; rollback preserves config on failed persistence. */
export async function migrateCoreSkillsSettings(store: MigrationStore): Promise<ServiceResult<void>> {
  const before = store.get();
  const oldSkills = before.skills ? { ...before.skills } : undefined;
  const oldApps = before.apps ? { ...before.apps, apps: { ...before.apps.apps } } : { apps: {} };
  const legacy = oldApps.apps.skills;
  if (before.skills?.legacyMigrationComplete && !legacy) return { ok: true, value: undefined };
  const nextSkills = { ...deriveCoreSkillsSettings(before.skills, legacy), legacyMigrationComplete: true };
  const nextApps = { ...oldApps, apps: { ...oldApps.apps } };
  delete nextApps.apps.skills;
  store.apply(nextSkills, nextApps);
  try {
    await store.save();
    return { ok: true, value: undefined };
  } catch (error) {
    // Old config remains recoverable and cannot become a duplicate app registration.
    store.apply(oldSkills, oldApps);
    return { ok: false, error: { code: 'persistence', message: error instanceof Error ? error.message : String(error) } };
  }
}
