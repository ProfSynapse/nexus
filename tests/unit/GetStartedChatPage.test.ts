/**
 * Get started → Chat inside Obsidian. Failure this buys: step 1 claiming
 * "Connected" with nothing set up (or listing provider names, which belong to
 * the Providers tab), "Open providers" not landing on Providers, "Open chat"
 * running the wrong command, or the old copy promising a Ctrl/Cmd+Shift+C
 * hotkey that the open-chat command never registered.
 *
 * Real pieces: the page renderer, SettingsRouter, BackButton and the
 * Setting/SettingGroup mocks rendering a FakeElement tree.
 */
import { Component } from 'obsidian';
import { createFakeRoot, FakeElement } from '../mocks/obsidian/dom';
import { SettingsRouter } from '../../src/settings/SettingsRouter';
import { renderChatSetupPage } from '../../src/settings/getStarted/ChatSetupPage';
import { CHAT_PAGE } from '../../src/settings/getStarted/copy';
import type { LLMProviderSettings } from '../../src/types/llm/ProviderTypes';

const configured = {
  defaultModel: { provider: 'openai', model: 'gpt-test' },
  providers: { openai: { enabled: true, apiKey: 'test-key' } }
} as unknown as LLMProviderSettings;

function render(llmProviders?: LLMProviderSettings) {
  const container = createFakeRoot();
  const router = new SettingsRouter();
  router.openPage('get-started');
  router.openPage('get-started-chat');
  const executeCommandById = jest.fn().mockResolvedValue(undefined);
  const closeSettings = jest.fn();
  renderChatSetupPage(container as unknown as HTMLElement, {
    app: { commands: { executeCommandById } } as never,
    router,
    component: new Component(),
    llmProviders,
    pluginId: 'nexus',
    closeSettings
  });
  return { container, router, executeCommandById, closeSettings };
}

/** Step rows, in order, as [badge, name text without the badge]. */
function steps(container: FakeElement): Array<[string, string]> {
  return container.querySelectorAll('.setting-item').map(row => {
    const name = row.querySelector('.setting-item-name')!;
    const badge = name.querySelector('.nexus-step')?.textContent ?? '';
    return [badge, name.textContent.slice(badge.length)];
  });
}

function row(container: FakeElement, index: number): FakeElement {
  return container.querySelectorAll('.setting-item')[index];
}

function button(scope: FakeElement, text: string): FakeElement {
  const match = scope.querySelectorAll('button').find(el => el.textContent === text);
  if (!match) throw new Error(`No button ${text}`);
  return match;
}

it('shows three numbered steps with the mockup copy', () => {
  const { container } = render(configured);
  expect(container.querySelector('.nexus-page-title')?.textContent).toBe(CHAT_PAGE.title);
  expect(steps(container)).toEqual([
    ['1', CHAT_PAGE.providerName],
    ['2', CHAT_PAGE.openChatName],
    ['3', CHAT_PAGE.startName]
  ]);
  expect(row(container, 1).querySelector('.setting-item-description')?.textContent).toBe(CHAT_PAGE.openChatDesc);
});

it('says "Connected" only when a provider is configured, and never names providers', () => {
  const ready = render(configured).container;
  const status = row(ready, 0).querySelector('.nexus-status');
  expect(status?.textContent).toBe(CHAT_PAGE.connected);
  expect(status?.hasClass('is-ok')).toBe(true);
  expect(ready.textContent).not.toMatch(/openai|gpt-test/i);

  const fresh = render(undefined).container;
  expect(row(fresh, 0).querySelector('.nexus-status')).toBeNull();
  expect(fresh.textContent).not.toContain(CHAT_PAGE.connected);
});

it('does not promise a keyboard shortcut', () => {
  const { container } = render(configured);
  expect(container.textContent).not.toMatch(/ctrl|cmd|shift\s*\+/i);
});

it('"Open providers" closes the page on the Providers tab', () => {
  const { container, router } = render(undefined);
  button(row(container, 0), CHAT_PAGE.openProviders).dispatch('click');
  expect(router.getState()).toEqual(expect.objectContaining({ tab: 'providers', page: undefined }));
});

it('"Open chat" runs the plugin\'s open-chat command and closes settings', async () => {
  const { container, executeCommandById, closeSettings } = render(configured);
  button(row(container, 1), CHAT_PAGE.openChat).dispatch('click');
  await new Promise(resolve => setImmediate(resolve));
  expect(executeCommandById).toHaveBeenCalledWith('nexus:open-chat');
  expect(closeSettings).toHaveBeenCalledTimes(1);
});

it('Back goes to Get started', () => {
  const { container, router } = render(configured);
  const back = container.querySelector('.nexus-back-button')!;
  expect(back.textContent).toBe('Get started');
  back.dispatch('click');
  expect(router.getState().page).toBe('get-started');
});
