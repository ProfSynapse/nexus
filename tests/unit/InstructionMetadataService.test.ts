/** Failed persistence must not change effective archive/category state or finish migration. */
import { InstructionMetadataService, normalizeInstructionLibrarySettings } from '../../src/services/instructions/InstructionMetadataService';
import { decodeInstructionReference, encodeInstructionReference } from '../../src/services/instructions/InstructionReferenceCodec';
import type { InstructionLibrarySettings } from '../../src/services/instructions/types';

const reference = { provider: 'research', name: 'source-review' };
function fixture(initial: unknown = undefined) {
  let settings: unknown = initial;
  const saved: InstructionLibrarySettings[] = [];
  const save = jest.fn(async () => { saved.push(JSON.parse(JSON.stringify(settings)) as InstructionLibrarySettings); });
  const service = new InstructionMetadataService({ getSettings: () => settings, setSettings: next => { settings = next; }, saveSettings: save });
  return { service, save, saved, current: () => settings, reload: (value: unknown) => { settings = value; } };
}

describe('instruction identity and durable organization', () => {
  test('qualified identities with separators, quotes, commas and newlines round-trip without collisions', () => {
    const references = [
      { type: 'skill' as const, provider: 'a:b', name: 'c' },
      { type: 'skill' as const, provider: 'a', name: 'b:c' },
      { type: 'prompt' as const, id: 'a,b\n"quoted"' },
      { type: 'skill' as const, provider: '__proto__', name: 'constructor' }
    ];
    expect(new Set(references.map(encodeInstructionReference)).size).toBe(references.length);
    for (const item of references) expect(decodeInstructionReference(encodeInstructionReference(item))).toEqual(item);
    for (const invalid of ['__proto__', 'null', '["future","name"]', '["skill","", "x"]']) expect(decodeInstructionReference(invalid)).toBeUndefined();
  });

  test('normalizes nested invalid settings and refuses prompt archive as a second authority', () => {
    const skillKey = encodeInstructionReference({ type: 'skill', ...reference });
    const promptKey = encodeInstructionReference({ type: 'prompt', id: 'unchanged-id' });
    expect(normalizeInstructionLibrarySettings({ items: { [skillKey]: { categories: [' A ', '', 'A', 4], archived: true }, [promptKey]: { archived: true }, bad: { archived: true } }, skillArchiveImportComplete: 'true' }))
      .toEqual({ version: 1, items: { [skillKey]: { categories: ['A'], archived: true }, [promptKey]: {} } });
    expect(normalizeInstructionLibrarySettings({ version: 9, items: {} })).toEqual({ version: 1, items: {} });
  });

  test('effective reads await save and failure restores previous state', async () => {
    const state = fixture();
    let reject: (reason: Error) => void = () => undefined;
    state.save.mockImplementationOnce(() => new Promise<void>((_resolve, rejection) => { reject = rejection; }));
    const pending = state.service.setArchived(reference, true);
    await Promise.resolve();
    expect(state.service.isArchived(reference)).toBe(false);
    reject(new Error('disk full'));
    expect(await pending).toMatchObject({ ok: false, error: { code: 'persistence' } });
    expect(state.service.isArchived(reference)).toBe(false);
    expect(await state.service.setArchived(reference, true)).toEqual({ ok: true, value: undefined });
    expect(state.service.isArchived(reference)).toBe(true);
  });

  test('serializes concurrent edits without losing categories or archive state, and survives restart', async () => {
    const state = fixture();
    await Promise.all([state.service.setCategories({ type: 'skill', ...reference }, ['Operations']), state.service.setArchived(reference, true)]);
    expect(state.saved).toHaveLength(2);
    const restart = fixture(state.saved[1]);
    expect(restart.service.categories({ type: 'skill', ...reference })).toEqual(['Operations']);
    expect(restart.service.isArchived(reference)).toBe(true);
    // No index rows are consulted: the identity remains archived if the folder disappears/reimports.
    expect(await restart.service.ensureLegacyArchiveImported([], true)).toEqual({ ok: true, value: undefined });
    expect(restart.service.isArchived(reference)).toBe(true);
  });

  test('legacy seed requires readiness, honors explicit overrides and marks only after durable save', async () => {
    const state = fixture();
    expect(await state.service.ensureLegacyArchiveImported([], false)).toMatchObject({ ok: false, error: { code: 'initializing' } });
    expect(state.save).not.toHaveBeenCalled();
    await state.service.setArchived(reference, false);
    state.save.mockRejectedValueOnce(new Error('failed migration save'));
    const rows = [{ ...reference, isArchived: true }, { provider: 'nexus', name: 'archived-package', isArchived: true }];
    expect(await state.service.ensureLegacyArchiveImported(rows, true)).toMatchObject({ ok: false });
    expect(normalizeInstructionLibrarySettings(state.current()).skillArchiveImportComplete).toBeUndefined();
    expect(await state.service.ensureLegacyArchiveImported(rows, true)).toMatchObject({ ok: true });
    expect(state.service.isArchived(reference)).toBe(false);
    expect(state.service.isArchived(rows[1])).toBe(true);
    const count = state.save.mock.calls.length;
    await state.service.ensureLegacyArchiveImported([{ provider: 'new', name: 'unexpected', isArchived: true }], true);
    expect(state.save.mock.calls.length).toBe(count);
  });

  test('empty category override wins, clearing restores declarations; external reload invalidates projection', async () => {
    const state = fixture();
    const ref = { type: 'skill' as const, ...reference };
    expect(state.service.categories(ref, ['Declared'])).toEqual(['Declared']);
    await state.service.setCategories(ref, []);
    expect(state.service.categories(ref, ['Declared'])).toEqual([]);
    await state.service.clearCategoryOverride(ref);
    expect(state.service.categories(ref, ['Declared'])).toEqual(['Declared']);
    state.reload({ version: 1, items: { [encodeInstructionReference(ref)]: { categories: ['Reloaded'] } } });
    expect(state.service.categories(ref)).toEqual(['Reloaded']);
  });

  test('rename transfers durable metadata and rejects destination collisions without saving', async () => {
    const state = fixture();
    await state.service.setArchived(reference, true);
    await state.service.setCategories({ type: 'skill', ...reference }, ['Review']);
    const renamed = { ...reference, name: 'new-name' };
    expect(await state.service.transferIdentity(reference, renamed)).toMatchObject({ ok: true });
    expect(state.service.isArchived(renamed)).toBe(true);
    expect(state.service.isArchived(reference)).toBe(true);
    expect(state.service.categories({ type: 'skill', ...reference })).toEqual([]);
    // A scanner/provider reimport of the old identity still observes its archive tombstone.
    const restart = fixture(state.current());
    expect(restart.service.isArchived(reference)).toBe(true);
    const other = { ...reference, name: 'existing-tombstone' };
    await state.service.setArchived(other, true);
    const count = state.save.mock.calls.length;
    expect(await state.service.transferIdentity(renamed, other)).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(state.save.mock.calls.length).toBe(count);
    expect(state.service.categories({ type: 'skill', ...renamed })).toEqual(['Review']);
  });

  test('successful saves notify subscribers and unsubscribe/external reload are explicit', async () => {
    const state = fixture();
    const listener = jest.fn();
    const unsubscribe = state.service.subscribe(listener);
    await state.service.setArchived(reference, true);
    expect(listener).toHaveBeenCalledTimes(1);
    state.save.mockRejectedValueOnce(new Error('failure'));
    await state.service.setArchived(reference, false);
    expect(listener).toHaveBeenCalledTimes(1);
    state.reload(undefined);
    state.service.invalidate();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    await state.service.setArchived(reference, true);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
