/** Fails if disabled legacy settings begin automatic writes or failed migration loses config. */
import { deriveCoreSkillsSettings, migrateCoreSkillsSettings } from '../../src/services/skills/migrateCoreSkillsSettings';
import type { AppConfig, AppsSettings } from '../../src/types/apps/AppTypes';
import type { CoreSkillsSettings } from '../../src/services/instructions/types';

const legacy = (enabled: boolean): AppConfig => ({ enabled, credentials: {}, installedAt: '2026-01-01', installedVersion: '1.0.0' });
describe('Core skills settings migration', () => {
  it.each([true, false])('preserves prior automatic behavior only for enabled=%s', async enabled => {
    let doc: { skills?: CoreSkillsSettings; apps: AppsSettings } = { apps: { apps: { skills: legacy(enabled), other: legacy(true) } } };
    const save = jest.fn(async () => undefined);
    const result = await migrateCoreSkillsSettings({ get: () => doc, apply: (skills, apps) => { doc = { skills, apps }; }, save });
    expect(result.ok).toBe(true); expect(doc.skills).toMatchObject({ automaticImport: enabled, syncBackOnEdit: enabled, legacyMigrationComplete: true });
    expect(doc.apps.apps.skills).toBeUndefined(); expect(doc.apps.apps.other).toBeDefined();
    await migrateCoreSkillsSettings({ get: () => doc, apply: (skills, apps) => { doc = { skills, apps }; }, save });
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('new installs do not start imports or source writes', () => {
    expect(deriveCoreSkillsSettings(undefined)).toMatchObject({ automaticImport: false, syncBackOnEdit: false });
  });
  it('rolls back a live settings object mutated by the production bridge', async () => {
    const original = legacy(true);
    const doc: { skills?: CoreSkillsSettings; apps: AppsSettings } = { apps: { apps: { skills: original } } };
    const save = jest.fn(async () => { throw new Error('disk full'); });
    const bridge = { get: () => doc, apply: (skills: CoreSkillsSettings | undefined, apps: AppsSettings) => { doc.skills = skills; doc.apps = apps; }, save };
    expect((await migrateCoreSkillsSettings(bridge)).ok).toBe(false);
    expect(doc.apps.apps.skills).toBe(original);
    expect(doc.skills).toBeUndefined();
    save.mockImplementation(async () => undefined);
    expect((await migrateCoreSkillsSettings(bridge)).ok).toBe(true);
    expect(doc.apps.apps.skills).toBeUndefined();
    expect(doc.skills).toMatchObject({ legacyMigrationComplete: true, automaticImport: true, syncBackOnEdit: true });
    expect(save).toHaveBeenCalledTimes(2);
  });
  it('failed persistence retains original config and leaves automatic writes off', async () => {
    const original = legacy(true);
    let doc: { skills?: CoreSkillsSettings; apps: AppsSettings } = { apps: { apps: { skills: original } } };
    const result = await migrateCoreSkillsSettings({ get: () => doc, apply: (skills, apps) => { doc = { skills, apps }; }, save: async () => { throw new Error('disk full'); } });
    expect(result.ok).toBe(false); expect(doc.apps.apps.skills).toBe(original);
    expect(doc.skills).toBeUndefined();
  });
});
