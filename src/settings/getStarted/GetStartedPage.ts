/**
 * The Get started row above the tab strip and the Get started page it opens.
 * Mobile-safe: the external-agent path is offered only on desktop, and its
 * status comes from getStartedStatus, which loads Node built-ins lazily.
 */
import { App, Component, Setting, setIcon } from 'obsidian';
import type { SettingsRouter } from '../SettingsRouter';
import type { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import { createSettingGroup } from '../../components/shared/settings/settingGroup';
import { countExternalConnections, hasConfiguredProviders } from '../getStartedStatus';
import { BACK_TO_SETTINGS, GET_STARTED_PAGE, GET_STARTED_ROW } from './copy';
import { addNavigableRow, renderPageHead } from './pageParts';

export interface GetStartedPageContext {
  app: App;
  router: SettingsRouter;
  component: Component;
  llmProviders?: LLMProviderSettings;
  /** Desktop with the MCP bridge: the external-agent path is offered. */
  externalAgentsAvailable: boolean;
}

/** The single navigable row above the tab strip. */
export function renderGetStartedRow(container: HTMLElement, router: SettingsRouter, component: Component): void {
  const { itemsEl } = createSettingGroup(container, 'nexus-get-started');
  addNavigableRow(itemsEl, {
    icon: 'rocket',
    name: GET_STARTED_ROW.name,
    desc: GET_STARTED_ROW.desc,
    onOpen: () => router.openPage('get-started')
  }, component);
}

export function renderGetStartedPage(container: HTMLElement, context: GetStartedPageContext): void {
  const { router, component } = context;
  renderPageHead(container, {
    backLabel: BACK_TO_SETTINGS,
    onBack: () => router.back(),
    title: GET_STARTED_PAGE.title
  }, component);

  container.createEl('p', { cls: 'nexus-page-lede', text: GET_STARTED_PAGE.lede });

  const list = container.createEl('ul', { cls: 'nexus-can' });
  for (const capability of GET_STARTED_PAGE.capabilities) {
    const item = list.createEl('li');
    setIcon(item.createSpan({ cls: 'nexus-can-icon' }), capability.icon);
    item.createSpan({ text: capability.text });
  }

  new Setting(container)
    .setHeading()
    .setName(GET_STARTED_PAGE.setupHeading)
    .setDesc(GET_STARTED_PAGE.setupDesc)
    .setClass('nexus-gs-heading');

  const { itemsEl } = createSettingGroup(container);
  addNavigableRow(itemsEl, {
    icon: 'message-square',
    name: GET_STARTED_PAGE.chatName,
    desc: GET_STARTED_PAGE.chatDesc,
    value: hasConfiguredProviders(context.llmProviders) ? GET_STARTED_PAGE.chatReady : GET_STARTED_PAGE.chatNotSetUp,
    onOpen: () => router.openPage('get-started-chat')
  }, component);

  if (context.externalAgentsAvailable) {
    addNavigableRow(itemsEl, {
      icon: 'plug',
      name: GET_STARTED_PAGE.agentsName,
      desc: GET_STARTED_PAGE.agentsDesc,
      value: GET_STARTED_PAGE.connectedCount(countExternalConnections(context.app)),
      onOpen: () => router.openPage('get-started-agents')
    }, component);
  }
}
