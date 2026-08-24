import {
  deriveStateMetadata,
  deriveStateMetadataFromJson,
  resolveStateDescription
} from '../../src/database/utils/stateContent';

/**
 * src/database/utils/stateContent.ts is the ONLY place the denormalized
 * `states` columns are derived, and it is deliberately shared by both writers:
 *
 *  - StateRepository.saveState / updateState — the live write path
 *  - WorkspaceEventApplier.applyStateSaved / applyStateUpdated — JSONL replay
 *
 * If the two ever disagreed, "Nexus: Rebuild cache" would silently change which
 * states a list shows. They agree because they call this module, so this module
 * is where the contract has to be pinned.
 */
describe('deriveStateMetadata', () => {
  it('treats ONLY an explicit boolean true as archived', () => {
    // The strict check matters: a snapshot written by an older tool version, or
    // hand-edited JSONL, can carry a truthy non-boolean here. Coercing it would
    // hide a state the user never archived, and a state wrongly hidden from a
    // list is the failure direction that loses data.
    expect(deriveStateMetadata({ state: { metadata: { isArchived: true } } }).isArchived).toBe(true);

    for (const truthyButNotTrue of ['true', 'false', 1, {}, [], 'yes']) {
      expect(
        deriveStateMetadata({ state: { metadata: { isArchived: truthyButNotTrue } } }).isArchived
      ).toBe(false);
    }
  });

  it('reports not-archived for false, absent, and structurally unexpected content', () => {
    expect(deriveStateMetadata({ state: { metadata: { isArchived: false } } }).isArchived).toBe(false);
    expect(deriveStateMetadata({ state: { metadata: {} } }).isArchived).toBe(false);
    expect(deriveStateMetadata({ state: {} }).isArchived).toBe(false);
    expect(deriveStateMetadata({}).isArchived).toBe(false);
    expect(deriveStateMetadata(null).isArchived).toBe(false);
    expect(deriveStateMetadata(undefined).isArchived).toBe(false);
    expect(deriveStateMetadata('not an object').isArchived).toBe(false);
    expect(deriveStateMetadata([{ state: { metadata: { isArchived: true } } }]).isArchived).toBe(false);
  });

  it('trims context.activeTask and drops it when blank or non-string', () => {
    expect(deriveStateMetadata({ context: { activeTask: '  Ship the migration  ' } }).activeTask)
      .toBe('Ship the migration');
    expect(deriveStateMetadata({ context: { activeTask: '   ' } }).activeTask).toBeUndefined();
    expect(deriveStateMetadata({ context: { activeTask: '' } }).activeTask).toBeUndefined();
    expect(deriveStateMetadata({ context: { activeTask: 42 } }).activeTask).toBeUndefined();
    expect(deriveStateMetadata({ context: {} }).activeTask).toBeUndefined();
  });
});

describe('deriveStateMetadataFromJson', () => {
  it('returns null — not a guess — for absent or unparseable input', () => {
    // null is what lets the callers leave the column NULL ("unknown") instead
    // of asserting "not archived" about a snapshot they could not read.
    expect(deriveStateMetadataFromJson(undefined)).toBeNull();
    expect(deriveStateMetadataFromJson(null)).toBeNull();
    expect(deriveStateMetadataFromJson('')).toBeNull();
    expect(deriveStateMetadataFromJson('{not json')).toBeNull();
  });

  it('agrees with deriveStateMetadata on the same snapshot', () => {
    const content = {
      context: { activeTask: 'Fold the stream once' },
      state: { metadata: { isArchived: true } }
    };
    expect(deriveStateMetadataFromJson(JSON.stringify(content))).toEqual(deriveStateMetadata(content));
  });

  it('parses valid JSON that is not an object without throwing', () => {
    expect(deriveStateMetadataFromJson('"a string"')).toEqual({ isArchived: false });
    expect(deriveStateMetadataFromJson('null')).toEqual({ isArchived: false });
  });
});

describe('resolveStateDescription', () => {
  it('prefers the explicit description over the derived activeTask', () => {
    const derived = deriveStateMetadata({ context: { activeTask: 'Derived' } });
    expect(resolveStateDescription('Explicit', derived)).toBe('Explicit');
  });

  it('falls back to activeTask when no explicit description was supplied', () => {
    // createState writes no description, so without this fallback every state
    // that tool ever created lists as "No description".
    const derived = deriveStateMetadata({ context: { activeTask: 'Derived' } });
    expect(resolveStateDescription(null, derived)).toBe('Derived');
    expect(resolveStateDescription(undefined, derived)).toBe('Derived');
    expect(resolveStateDescription('', derived)).toBe('Derived');
  });

  it('returns null when neither source has anything to offer', () => {
    expect(resolveStateDescription(null, deriveStateMetadata({}))).toBeNull();
    expect(resolveStateDescription(null, null)).toBeNull();
    expect(resolveStateDescription('', null)).toBeNull();
  });
});
