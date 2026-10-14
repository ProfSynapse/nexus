/**
 * Defaults apply to new chats only (owner decision, 2026-10-14). Changing a
 * default context window must not reach into the open chat: no handoff, no
 * wait for it, and the default is published and saved straight away. The
 * previous behaviour pushed the edit into the active chat through
 * ChatView.applyContextWindowDefault and held the save until it committed.
 */
import { DefaultsTab } from '../../src/settings/tabs/DefaultsTab';
import { getContextWindowOverrideKey } from '../../src/ui/chat/utils/ContextWindowSettings';

function harness() {
  const key = getContextWindowOverrideKey('anthropic', 'source');
  const oldOverrides = { [key]: 250_000 };
  const llmProviderSettings = { contextWindowOverrides: oldOverrides };
  const saveSettings = jest.fn().mockResolvedValue(undefined);
  const activeChat = {
    applyContextWindowDefault: jest.fn().mockResolvedValue(true),
    requestContextChange: jest.fn().mockResolvedValue(true)
  };
  const getActiveViewOfType = jest.fn(() => activeChat);
  const tab = Object.create(DefaultsTab.prototype) as { saveSettings(settings: unknown): Promise<void>; services: unknown };
  tab.services = {
    app: { workspace: { getActiveViewOfType } },
    llmProviderSettings,
    settings: { settings: {}, saveSettings }
  };
  const next = {
    provider: 'anthropic', model: 'source', contextWindowOverrides: { [key]: 128_000 },
    thinking: { enabled: false, effort: 'medium' }, contextNotes: []
  };
  return { tab, key, llmProviderSettings, saveSettings, activeChat, getActiveViewOfType, next };
}

test('a lower default context window is saved without touching the open chat', async () => {
  const h = harness();
  await h.tab.saveSettings(h.next);
  expect(h.getActiveViewOfType).not.toHaveBeenCalled();
  expect(h.activeChat.applyContextWindowDefault).not.toHaveBeenCalled();
  expect(h.activeChat.requestContextChange).not.toHaveBeenCalled();
  expect(h.llmProviderSettings.contextWindowOverrides).toEqual(h.next.contextWindowOverrides);
  expect(h.saveSettings).toHaveBeenCalledTimes(1);
});

test('the saved default is a copy, so later renderer edits do not leak into settings', async () => {
  const h = harness();
  await h.tab.saveSettings(h.next);
  h.next.contextWindowOverrides[h.key] = 64_000;
  expect(h.llmProviderSettings.contextWindowOverrides[h.key]).toBe(128_000);
});
