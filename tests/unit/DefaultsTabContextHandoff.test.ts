jest.mock('../../src/ui/chat/ChatView', () => ({ ChatView: class {} }));
import { DefaultsTab } from '../../src/settings/tabs/DefaultsTab';
import { getContextWindowOverrideKey } from '../../src/ui/chat/utils/ContextWindowSettings';

// Defaults cannot publish a reduced budget before the active chat is prepared.
function harness() {
  const key = getContextWindowOverrideKey('anthropic', 'source');
  const oldOverrides = { [key]: 250_000 };
  const llmProviderSettings = { contextWindowOverrides: oldOverrides };
  const saveSettings = jest.fn().mockResolvedValue(undefined);
  const applyContextWindowDefault = jest.fn().mockResolvedValue(true);
  const tab = Object.create(DefaultsTab.prototype);
  tab.services = {
    app: { workspace: { getActiveViewOfType: () => ({ applyContextWindowDefault }) } },
    llmProviderSettings,
    settings: { settings: {}, saveSettings }
  };
  const next = {
    provider: 'anthropic', model: 'source', contextWindowOverrides: { [key]: 128_000 },
    thinking: { enabled: false, effort: 'medium' }, contextNotes: []
  };
  return { tab, key, oldOverrides, llmProviderSettings, saveSettings, applyContextWindowDefault, next };
}

test('waits for the active chat before publishing a lower default', async () => {
  const h = harness();
  let release!: (value: boolean) => void;
  h.applyContextWindowDefault.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const save = h.tab.saveSettings(h.next);
  expect(h.llmProviderSettings.contextWindowOverrides).toBe(h.oldOverrides);
  expect(h.saveSettings).not.toHaveBeenCalled();
  release(true);
  await save;
  expect(h.applyContextWindowDefault).toHaveBeenCalledWith(h.next.contextWindowOverrides, new Set([h.key]));
  expect(h.llmProviderSettings.contextWindowOverrides).toEqual(h.next.contextWindowOverrides);
  expect(h.saveSettings).toHaveBeenCalledTimes(1);
});

test('cancelled preparation preserves the defaults', async () => {
  const h = harness();
  h.applyContextWindowDefault.mockResolvedValue(false);
  await h.tab.saveSettings(h.next);
  expect(h.llmProviderSettings.contextWindowOverrides).toBe(h.oldOverrides);
  expect(h.saveSettings).not.toHaveBeenCalled();
});

test('unrelated settings changes do not hand off the active chat', async () => {
  const h = harness();
  await h.tab.saveSettings({ ...h.next, contextWindowOverrides: h.oldOverrides });
  expect(h.applyContextWindowDefault).not.toHaveBeenCalled();
  expect(h.saveSettings).toHaveBeenCalledTimes(1);
});
