/**
 * Get started → Chat inside Obsidian: three numbered steps. Mobile-safe.
 */
import { App, Component, Notice, Setting } from 'obsidian';
import type { SettingsRouter } from '../SettingsRouter';
import type { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import { createSettingGroup } from '../../components/shared/settings/settingGroup';
import { hasConfiguredProviders } from '../getStartedStatus';
import { BACK_TO_GET_STARTED, CHAT_PAGE } from './copy';
import { addStatus, renderPageHead, setStepName } from './pageParts';

export interface ChatSetupPageContext {
  app: App;
  router: SettingsRouter;
  component: Component;
  llmProviders?: LLMProviderSettings;
  /** The plugin's manifest id; the chat command is `<id>:open-chat`. */
  pluginId: string;
  /** Close the settings window so the chat is visible. */
  closeSettings: () => void;
}

export function renderChatSetupPage(container: HTMLElement, context: ChatSetupPageContext): void {
  const { router, component } = context;
  renderPageHead(container, {
    backLabel: BACK_TO_GET_STARTED,
    onBack: () => router.back(),
    title: CHAT_PAGE.title
  }, component);

  const { itemsEl } = createSettingGroup(container);
  const configured = hasConfiguredProviders(context.llmProviders);

  const provider = new Setting(itemsEl).setDesc(CHAT_PAGE.providerDesc);
  setStepName(provider, 1, CHAT_PAGE.providerName);
  if (configured) {
    addStatus(provider, CHAT_PAGE.connected, true);
  }
  provider.addButton(button => {
    button.setButtonText(CHAT_PAGE.openProviders).onClick(() => router.setTab('providers'));
    if (!configured) button.setCta();
  });

  const openChat = new Setting(itemsEl).setDesc(CHAT_PAGE.openChatDesc);
  setStepName(openChat, 2, CHAT_PAGE.openChatName);
  openChat.addButton(button => button
    .setButtonText(CHAT_PAGE.openChat)
    .setCta()
    .onClick(async () => {
      try {
        await context.app.commands.executeCommandById(`${context.pluginId}:open-chat`);
        context.closeSettings();
      } catch (error) {
        console.error('[ChatSetupPage] Could not open the chat:', error);
        new Notice('Could not open the chat.');
      }
    }));

  const start = new Setting(itemsEl).setDesc(CHAT_PAGE.startDesc);
  setStepName(start, 3, CHAT_PAGE.startName);
}
