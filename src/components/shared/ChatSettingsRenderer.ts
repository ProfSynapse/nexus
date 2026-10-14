/**
 * ChatSettingsRenderer - Shared settings UI for the Defaults tab and the Chat settings modal.
 *
 * Layout ("Essentials + folds"):
 * - an always-open top block (an Obsidian SettingGroup with no heading) holding
 *   Provider, Model and Thinking;
 * - collapsible folds (the shared Accordion), each with an icon and a one-line
 *   summary while closed: Chat options, Context, Subagents, Images, Voice, plus
 *   any folds the host adds (Video, File conversion, Semantic search on Defaults).
 *
 * The shell (top block and accordions) is built once. Each group empties and
 * refills only its own `setting-items` list, so a provider change, a workspace
 * change or a synced settings update never collapses a fold or loses the scroll
 * position. Fold open/closed state is remembered per device and per surface.
 *
 * The surfaces differ only in which rows appear (Web search and Workflow are
 * chat-only) and where data is saved (via callbacks).
 */

import { App, Component, EventRef, Setting, setIcon } from 'obsidian';
import { LLMProviderManager } from '../../services/llm/providers/ProviderManager';
import { StaticModelsService } from '../../services/StaticModelsService';
import { ImageGenerationService } from '../../services/llm/ImageGenerationService';
import { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import type { AppsSettings } from '../../types/apps/AppTypes';
import { isTextOnlyProvider } from '../../services/llm/utils/ToolSchemaSupport';
import { FilePickerRenderer } from '../workspace/FilePickerRenderer';
import { isProviderCompatible } from '../../utils/platform';
import { LLMSettingsNotifier } from '../../services/llm/LLMSettingsNotifier';
import { renderModelSetting, renderProviderSetting, type ModelDropdownConfig } from './ModelDropdownRenderer';
import { ProviderUtils } from '../../ui/chat/utils/ProviderUtils';
import { getNexusPlugin } from '../../utils/pluginLocator';
import { sortModelsNewestFirst } from '../../utils/modelOrdering';
import { getContextWindowOverrideKey, resolveContextWindowLimit } from '../../ui/chat/utils/ContextWindowSettings';
import { Accordion } from '../Accordion';
import { FoldStateStore } from './settings/FoldStateStore';
import { createSettingGroup, type SettingGroupHandle } from './settings/settingGroup';
import { bindSliderReadout } from './settings/sliderReadout';
import { COPY, FOLD_ICONS, FOLD_IDS, FOLD_TITLES } from './chatSettings/copy';
import {
  chatOptionsSummary,
  contextSummary,
  formatContextWindow,
  formatTemperature,
  imagesSummary,
  subagentsSummary
} from './chatSettings/sectionSummaries';
import {
  getThinkingLevels,
  optionToThinking,
  THINKING_LABELS,
  thinkingToOption
} from './chatSettings/thinkingOptions';
import { VoiceSettings, type VoiceAudioFolderOption } from './chatSettings/VoiceSettings';
import type {
  ChatSettings,
  ChatSettingsOptions,
  FoldDefinition,
  FoldHost,
  SettingsSurface
} from './chatSettings/types';

export type { ChatSettings, ChatSettingsOptions, FoldDefinition, FoldHost, SettingsSurface } from './chatSettings/types';

/**
 * Local providers that can't be used for executePrompt
 */
const LOCAL_PROVIDERS = ['webllm', 'ollama', 'lmstudio'];

/**
 * Callbacks for when settings change
 */
export interface ChatSettingsCallbacks {
  onSettingsChange: (settings: ChatSettings) => void;
}

/**
 * Renderer configuration
 */
export interface ChatSettingsRendererConfig {
  app: App;
  llmProviderSettings: LLMProviderSettings;
  initialSettings: ChatSettings;
  options: ChatSettingsOptions;
  callbacks: ChatSettingsCallbacks;
  /** Which screen this is: decides chat-only rows and where fold state is remembered. */
  surface: SettingsSurface;
  /** Device-local fold memory; defaults to one backed by `app`'s local storage. */
  foldStore?: FoldStateStore;
  /** Host-specific folds (Video, File conversion, Semantic search on Defaults). */
  extraFolds?: Array<FoldDefinition & { after?: string }>;
  /** Defaults only: the saved read-aloud audio folder row in the Voice fold. */
  voiceAudioFolder?: VoiceAudioFolderOption;
}

interface PluginWithAppSettings {
  settings?: {
    settings?: {
      apps?: AppsSettings;
    };
  };
}

const TOP_GROUP = 'top';

interface FoldRecord {
  id: string;
  accordion: Accordion;
  render: (itemsEl: HTMLElement) => void;
  summary?: () => string;
  definition?: FoldDefinition;
}

export class ChatSettingsRenderer {
  private container: HTMLElement;
  private config: ChatSettingsRendererConfig;
  private providerManager: LLMProviderManager;
  private staticModelsService: StaticModelsService;
  private settings: ChatSettings;
  private settingsEventRef?: EventRef;
  private imageService: ImageGenerationService;
  private foldStore: FoldStateStore;
  private voice: VoiceSettings;

  // Stable shell: built once, never rebuilt by a redraw.
  private topGroup: SettingGroupHandle | null = null;
  private folds = new Map<string, FoldRecord>();
  // One Component per group owns that group's DOM listeners; unloaded when the group redraws.
  private groupEvents = new Map<string, Component>();

  // Maps dropdown option value -> actual { provider, modelId } for merged model lists
  private modelOptionMap: Map<string, { provider: string; modelId: string }> = new Map();
  private agentModelOptionMap: Map<string, { provider: string; modelId: string }> = new Map();
  private modelNames: { chat?: string; agent?: string; image?: string } = {};
  // Context windows discovered at runtime (Ollama, LM Studio), keyed by provider/model.
  private discoveredContextWindows = new Map<string, number>();
  private pendingContextLookups = new Set<string>();

  constructor(container: HTMLElement, config: ChatSettingsRendererConfig) {
    this.container = container;
    this.config = config;
    this.settings = {
      ...config.initialSettings,
      contextNotes: [...(config.initialSettings.contextNotes ?? [])],
      contextWindowOverrides: { ...(config.initialSettings.contextWindowOverrides ?? config.llmProviderSettings.contextWindowOverrides ?? {}) }
    };
    this.staticModelsService = StaticModelsService.getInstance();
    this.foldStore = config.foldStore ?? new FoldStateStore(config.app);

    this.providerManager = new LLMProviderManager(
      config.llmProviderSettings,
      config.app.vault
    );

    this.imageService = new ImageGenerationService(config.app.vault, config.llmProviderSettings);

    const settings = (): ChatSettings => this.settings;
    const llmProviderSettings = (): LLMProviderSettings => this.config.llmProviderSettings;
    const providerManager = (): LLMProviderManager => this.providerManager;
    this.voice = new VoiceSettings({
      surface: config.surface,
      get settings() { return settings(); },
      get llmProviderSettings() { return llmProviderSettings(); },
      get providerManager() { return providerManager(); },
      notifyChange: () => this.notifyChange(),
      setSummary: summary => this.folds.get(FOLD_IDS.voice)?.accordion.setSummary(summary),
      redraw: () => this.redrawGroups([FOLD_IDS.voice]),
      getProviderDisplayName: id => this.getProviderDisplayName(id),
      getAppsSettings: () => this.getAppsSettings(),
      audioFolder: config.voiceAudioFolder
    });

    this.settingsEventRef = LLMSettingsNotifier.onSettingsChanged((newSettings) => {
      this.config.llmProviderSettings = newSettings;
      this.providerManager.updateSettings(newSettings);
      this.imageService.updateSettings(newSettings);
      this.render();
    });
  }

  destroy(): void {
    for (const events of this.groupEvents.values()) events.unload();
    this.groupEvents.clear();
    for (const fold of this.folds.values()) {
      fold.definition?.destroy?.();
      fold.accordion.unload();
    }
    if (this.settingsEventRef) {
      LLMSettingsNotifier.unsubscribe(this.settingsEventRef);
      this.settingsEventRef = undefined;
    }
  }

  /**
   * Draw the form. The first call builds the shell; later calls (synced
   * settings, provider changes elsewhere) refill every group in place.
   */
  render(): void {
    this.preserveScroll(() => {
      if (!this.topGroup) this.buildShell();
      this.renderGroups([TOP_GROUP, ...this.folds.keys()]);
    });
  }

  private get surface(): SettingsSurface {
    return this.config.surface;
  }

  private notifyChange(): void {
    this.config.callbacks.onSettingsChange({ ...this.settings });
    this.updateSummaries();
  }

  // ========== SHELL ==========

  private buildShell(): void {
    this.container.empty();
    this.container.addClass('chat-settings-renderer');
    this.container.addClass('nexus-settings-folds');
    this.topGroup = createSettingGroup(this.container, 'nexus-settings-essentials');

    const shared: FoldRecord[] = [
      this.createFold(FOLD_IDS.chatOptions, FOLD_TITLES.chatOptions, FOLD_ICONS.chatOptions,
        el => this.renderChatOptions(el), () => this.chatOptionsSummary()),
      this.createFold(FOLD_IDS.context, FOLD_TITLES.context, FOLD_ICONS.context,
        el => this.renderContext(el), () => this.contextSummary()),
      this.createFold(FOLD_IDS.subagents, FOLD_TITLES.subagents, FOLD_ICONS.subagents,
        el => this.renderSubagents(el), () => this.subagentsSummary()),
      this.createFold(FOLD_IDS.images, FOLD_TITLES.images, FOLD_ICONS.images,
        el => this.renderImages(el), () => imagesSummary(this.modelNames.image ?? this.settings.imageModel)),
      this.createFold(FOLD_IDS.voice, FOLD_TITLES.voice, FOLD_ICONS.voice,
        el => this.voice.render(el), () => this.voice.getSummary())
    ];

    // Host folds go after the shared fold they name, otherwise at the end.
    const order = shared.map(fold => fold.id);
    const extras = this.config.extraFolds ?? [];
    for (const extra of extras) {
      const anchor = extra.after ? order.indexOf(extra.after) : -1;
      const index = anchor >= 0 ? anchor + 1 : order.length;
      order.splice(index, 0, extra.id);
    }
    const byId = new Map(shared.map(fold => [fold.id, fold]));
    for (const id of order) {
      const sharedFold = byId.get(id);
      if (sharedFold) {
        this.mountFold(sharedFold);
        continue;
      }
      const extra = extras.find(item => item.id === id);
      if (!extra) continue;
      const record = this.createFold(extra.id, extra.title, extra.icon,
        el => extra.render(el, this.createFoldHost(extra.id)));
      record.definition = extra;
      this.mountFold(record);
    }
  }

  /** Accordions are created detached from order; mountFold appends them in final order. */
  private createFold(
    id: string,
    title: string,
    icon: string,
    render: (itemsEl: HTMLElement) => void,
    summary?: () => string
  ): FoldRecord {
    const accordion = new Accordion(this.container, {
      id,
      title,
      icon,
      open: this.foldStore.isOpen(this.surface, id),
      onToggle: open => this.foldStore.setOpen(this.surface, id, open)
    });
    return { id, accordion, render, summary };
  }

  private mountFold(record: FoldRecord): void {
    // Re-append so the DOM order matches the fold order.
    this.container.appendChild(record.accordion.rootEl);
    this.folds.set(record.id, record);
  }

  private createFoldHost(id: string): FoldHost {
    const settings = (): ChatSettings => this.settings;
    const llmProviderSettings = (): LLMProviderSettings => this.config.llmProviderSettings;
    return {
      get settings() { return settings(); },
      get llmProviderSettings() { return llmProviderSettings(); },
      surface: this.surface,
      notifyChange: () => this.notifyChange(),
      setSummary: summary => this.folds.get(id)?.accordion.setSummary(summary),
      redraw: () => this.redrawGroups([id]),
      registerDomEvent: (el, type, callback) => this.events(id).registerDomEvent(el, type, callback)
    };
  }

  /** A fresh listener owner for a group, replacing (and unloading) the previous one. */
  private resetEvents(groupId: string): Component {
    this.groupEvents.get(groupId)?.unload();
    const events = new Component();
    events.load();
    this.groupEvents.set(groupId, events);
    return events;
  }

  private events(groupId: string): Component {
    return this.groupEvents.get(groupId) ?? this.resetEvents(groupId);
  }

  /** Redraw some groups, keeping the scroll position. */
  private redrawGroups(ids: string[]): void {
    this.preserveScroll(() => this.renderGroups(ids));
  }

  private renderGroups(ids: string[]): void {
    for (const id of ids) {
      if (id === TOP_GROUP) {
        if (!this.topGroup) continue;
        this.resetEvents(TOP_GROUP);
        this.topGroup.itemsEl.empty();
        this.renderTop(this.topGroup.itemsEl);
        continue;
      }
      const fold = this.folds.get(id);
      if (!fold) continue;
      this.resetEvents(id);
      fold.accordion.itemsEl.empty();
      fold.render(fold.accordion.itemsEl);
      if (fold.summary) fold.accordion.setSummary(fold.summary());
    }
  }

  private updateSummaries(): void {
    for (const fold of this.folds.values()) {
      if (fold.summary) fold.accordion.setSummary(fold.summary());
    }
  }

  private preserveScroll(work: () => void): void {
    const scroller = this.container.closest?.('.vertical-tab-content, .modal-content') as HTMLElement | null | undefined;
    const top = scroller?.scrollTop;
    work();
    if (scroller && typeof top === 'number' && scroller.scrollTop !== top) {
      scroller.scrollTop = top;
    }
  }

  // ========== PROVIDERS ==========

  private getEnabledProviders(): string[] {
    const llmSettings = this.config.llmProviderSettings;
    const providers = new Set<string>();

    for (const id of Object.keys(llmSettings.providers)) {
      if (id === 'openai-codex') {
        const config = llmSettings.providers[id];
        if (config?.enabled && config?.oauth?.connected && config?.apiKey) {
          providers.add('openai');
        }
        continue;
      }

      if (id === 'anthropic-claude-code') {
        const config = llmSettings.providers[id];
        if (config?.enabled && config?.oauth?.connected) {
          providers.add('anthropic');
        }
        continue;
      }

      if (id === 'google-gemini-cli') {
        const config = llmSettings.providers[id];
        if (config?.enabled && config?.oauth?.connected) {
          providers.add('google');
        }
        continue;
      }

      if (id === 'github-copilot') {
        const config = llmSettings.providers[id];
        if (config?.enabled && config?.oauth?.connected && config?.apiKey) {
          providers.add('github-copilot');
        }
        continue;
      }

      const config = llmSettings.providers[id];
      if (!config?.enabled) continue;
      if (!isProviderCompatible(config.driverKind ?? id)) continue;

      if (config.driverKind === 'openai-compatible') {
        if (config.openaiCompatible?.baseUrl.trim()) providers.add(id);
        continue;
      }

      if (id === 'webllm') {
        providers.add(id);
        continue;
      }

      if (config.apiKey) {
        providers.add(id);
      }
    }

    return Array.from(providers);
  }

  private isCodexConnected(): boolean {
    const codexConfig = this.config.llmProviderSettings.providers['openai-codex'];
    return !!(codexConfig?.oauth?.connected && codexConfig?.apiKey);
  }

  private isClaudeCodeConnected(): boolean {
    const claudeCodeConfig = this.config.llmProviderSettings.providers['anthropic-claude-code'];
    return !!claudeCodeConfig?.oauth?.connected;
  }

  private isGeminiCliConnected(): boolean {
    const geminiCliConfig = this.config.llmProviderSettings.providers['google-gemini-cli'];
    return !!geminiCliConfig?.oauth?.connected;
  }

  private modelDropdownConfig(variant: 'chat' | 'agent'): ModelDropdownConfig {
    const isAgent = variant === 'agent';
    return {
      getProviders: () => isAgent
        ? this.getEnabledProviders().filter(id => !LOCAL_PROVIDERS.includes(id))
        : this.getEnabledProviders(),
      getCurrentProvider: () => isAgent ? this.settings.agentProvider : this.settings.provider,
      getCurrentModel: () => isAgent ? this.settings.agentModel : this.settings.model,
      onProviderChange: (provider) => {
        if (isAgent) this.settings.agentProvider = provider;
        else this.settings.provider = provider ?? '';
      },
      onModelChange: (model, provider) => {
        if (isAgent) {
          this.settings.agentModel = model;
          if (provider !== undefined) this.settings.agentProvider = provider;
        } else {
          this.settings.model = model ?? '';
          if (provider !== undefined) this.settings.provider = provider;
        }
      },
      noProvidersText: isAgent ? COPY.noCloudProviders : COPY.noProviders,
      modelOptionMap: isAgent ? this.agentModelOptionMap : this.modelOptionMap,
      providerManager: this.providerManager,
      getProviderDisplayName: (id) => this.config.llmProviderSettings.providers[id]?.driverKind === 'openai-compatible'
        ? this.getProviderDisplayName(id) : undefined,
      isCodexConnected: () => this.isCodexConnected(),
      isClaudeCodeConnected: () => this.isClaudeCodeConnected(),
      isGeminiCliConnected: () => this.isGeminiCliConnected(),
      getDefaultModelForProvider: (id) => this.getDefaultModelForProvider(id),
      notifyChange: () => this.notifyChange(),
      onSelectionChanged: () => {
        if (isAgent) this.redrawGroups([FOLD_IDS.subagents]);
        // The chat model decides the top block, the chat options and (when no
        // subagent model is set) what the Subagents summary reports.
        else this.redrawGroups([TOP_GROUP, FOLD_IDS.chatOptions, FOLD_IDS.subagents]);
      },
      onModelNameResolved: (name) => {
        if (isAgent) this.modelNames.agent = name;
        else this.modelNames.chat = name;
        this.updateSummaries();
      }
    };
  }

  // ========== TOP BLOCK ==========

  private renderTop(itemsEl: HTMLElement): void {
    renderProviderSetting(itemsEl, this.modelDropdownConfig('chat'));
    const modelSetting = renderModelSetting(itemsEl, this.modelDropdownConfig('chat'));
    this.applyTextOnlyProviderWarning(modelSetting, 'chat');
    this.renderThinkingSetting(itemsEl, 'chat');
  }

  private supportsThinking(provider: string | undefined, model: string | undefined): boolean {
    if (!provider || !model) return false;
    return this.staticModelsService.findModel(provider, model)?.capabilities?.supportsThinking === true;
  }

  /**
   * The Thinking dropdown (Off, Low … Max). Present only when the model can
   * reason; Off keeps the stored effort so switching back restores it.
   */
  private renderThinkingSetting(itemsEl: HTMLElement, variant: 'chat' | 'agent'): void {
    const isAgent = variant === 'agent';
    const provider = isAgent ? this.settings.agentProvider : this.settings.provider;
    const model = isAgent ? this.settings.agentModel : this.settings.model;
    if (!this.supportsThinking(provider, model)) return;

    const current = isAgent ? this.settings.agentThinking : this.settings.thinking;
    new Setting(itemsEl)
      .setName(COPY.thinking)
      .addDropdown(dropdown => {
        dropdown.addOption('off', THINKING_LABELS.off);
        for (const level of getThinkingLevels(provider, model)) {
          dropdown.addOption(level, THINKING_LABELS[level]);
        }
        dropdown.setValue(thinkingToOption(current));
        dropdown.onChange(value => {
          const next = optionToThinking(value, isAgent ? this.settings.agentThinking : this.settings.thinking);
          if (isAgent) this.settings.agentThinking = next;
          else this.settings.thinking = next;
          this.notifyChange();
        });
      });
  }

  // ========== CHAT OPTIONS ==========

  private renderChatOptions(itemsEl: HTMLElement): void {
    const events = this.events(FOLD_IDS.chatOptions);

    const creativity = new Setting(itemsEl)
      .setName(COPY.creativity)
      .setDesc(COPY.creativityDesc);
    creativity.addSlider(slider => {
      slider
        .setLimits(0, 1, 0.1)
        .setValue(this.settings.temperature);
      bindSliderReadout(events, creativity, slider, formatTemperature);
      slider.onChange((value: number) => {
        this.settings.temperature = value;
        this.notifyChange();
      });
      return slider;
    });

    this.renderContextWindowSetting(itemsEl);

    if (this.surface === 'chat') this.renderWebSearchSetting(itemsEl);
  }

  /** The chat model's advertised window, from the registry or a runtime lookup. */
  private getChatContextWindow(): number | undefined {
    const { provider, model } = this.settings;
    if (!provider || !model) return undefined;
    const staticWindow = this.staticModelsService.findModel(provider, model)?.contextWindow;
    if (staticWindow && staticWindow > 0) return staticWindow;
    const key = getContextWindowOverrideKey(provider, model);
    const discovered = this.discoveredContextWindows.get(key);
    if (discovered) return discovered;
    this.lookupContextWindow(provider, model);
    return undefined;
  }

  private lookupContextWindow(provider: string, model: string): void {
    const key = getContextWindowOverrideKey(provider, model);
    if (this.pendingContextLookups.has(key)) return;
    this.pendingContextLookups.add(key);
    void this.providerManager.getModelsForProvider(provider).then(models => {
      const discovered = models.find(candidate => candidate.id === model)?.contextWindow;
      if (!discovered || discovered <= 0) return;
      this.discoveredContextWindows.set(key, discovered);
      if (provider === this.settings.provider && model === this.settings.model) {
        this.redrawGroups([FOLD_IDS.chatOptions]);
      }
    }).catch(() => {
      // An unavailable provider has no reliable advertised limit to adjust.
    });
  }

  /** The budget the chat will use: the override when set, else the model maximum. */
  private getChatContextBudget(): number | undefined {
    const advertised = this.getChatContextWindow();
    if (!advertised) return undefined;
    const maximum = resolveContextWindowLimit(advertised);
    const key = getContextWindowOverrideKey(this.settings.provider, this.settings.model);
    return resolveContextWindowLimit(maximum, this.settings.contextWindowOverrides?.[key]);
  }

  private renderContextWindowSetting(itemsEl: HTMLElement): void {
    const advertised = this.getChatContextWindow();
    if (!advertised) return;
    this.addContextWindowSlider(itemsEl, this.settings.provider, this.settings.model, advertised);
  }

  private addContextWindowSlider(itemsEl: HTMLElement, provider: string, model: string, advertised: number): void {
    const maximum = resolveContextWindowLimit(advertised);
    if (maximum <= 0) return;
    const key = getContextWindowOverrideKey(provider, model);
    const selected = resolveContextWindowLimit(maximum, this.settings.contextWindowOverrides?.[key]);
    const setting = new Setting(itemsEl)
      .setName(COPY.contextWindow)
      .setDesc(COPY.contextWindowDesc);

    setting.addSlider(slider => {
      slider
        .setLimits(Math.min(1024, maximum), maximum, 1)
        .setValue(selected);
      const format = (value: number): string => formatContextWindow(resolveContextWindowLimit(maximum, value));
      bindSliderReadout(this.events(FOLD_IDS.chatOptions), setting, slider, format, {
        ariaValueText: value => `${format(value)} tokens`,
        cls: 'nexus-ctx-value'
      });
      slider.onChange(value => {
        const limit = resolveContextWindowLimit(maximum, value);
        if (!this.settings.contextWindowOverrides) this.settings.contextWindowOverrides = {};
        if (limit === maximum) delete this.settings.contextWindowOverrides[key];
        else this.settings.contextWindowOverrides[key] = limit;
        this.notifyChange();
      });
      return slider;
    });
  }

  private supportsWebSearch(): boolean {
    return ['anthropic', 'openai', 'google', 'openrouter'].includes(this.settings.provider);
  }

  private renderWebSearchSetting(itemsEl: HTMLElement): void {
    if (!this.supportsWebSearch()) return;
    if (this.settings.provider === 'google' && !this.settings.model.startsWith('gemini-3')) {
      new Setting(itemsEl)
        .setName(COPY.webSearch)
        .setDesc(COPY.webSearchGeminiDesc);
      return;
    }
    new Setting(itemsEl)
      .setName(COPY.webSearch)
      .setDesc(COPY.webSearchDesc)
      .addToggle(toggle => toggle
        .setValue(this.settings.webSearch ?? false)
        .onChange(value => {
          this.settings.webSearch = value;
          this.notifyChange();
        }));
  }

  private chatOptionsSummary(): string {
    return chatOptionsSummary({
      temperature: this.settings.temperature,
      contextWindow: this.getChatContextBudget(),
      webSearch: this.surface === 'chat' ? this.settings.webSearch === true : undefined
    });
  }

  // ========== SUBAGENTS ==========

  /**
   * Subagents, saved prompts and automations. Always shown; local providers
   * are excluded because these run without the chat open.
   */
  private renderSubagents(itemsEl: HTMLElement): void {
    new Setting(itemsEl)
      .setName(COPY.usedFor)
      .setDesc(COPY.usedForDesc)
      .setClass('nexus-note');

    if (!this.settings.agentThinking) {
      this.settings.agentThinking = { enabled: false, effort: 'medium' };
    }

    renderProviderSetting(itemsEl, this.modelDropdownConfig('agent'));
    const modelSetting = renderModelSetting(itemsEl, this.modelDropdownConfig('agent'));
    this.applyTextOnlyProviderWarning(modelSetting, 'agent');
    this.renderThinkingSetting(itemsEl, 'agent');
  }

  private subagentsSummary(): string {
    const hasAgentModel = !!(this.settings.agentProvider && this.settings.agentModel);
    const provider = hasAgentModel ? this.settings.agentProvider : this.settings.provider;
    const model = hasAgentModel ? this.settings.agentModel : this.settings.model;
    const name = hasAgentModel
      ? this.modelDisplayName(provider, model, this.modelNames.agent)
      : this.modelDisplayName(provider, model, this.modelNames.chat);
    const thinking = hasAgentModel ? this.settings.agentThinking : this.settings.thinking;
    return subagentsSummary({
      modelName: name,
      thinking: this.supportsThinking(provider, model) ? thinking : null
    });
  }

  private modelDisplayName(provider: string | undefined, model: string | undefined, loadedName?: string): string | undefined {
    if (!provider || !model) return undefined;
    return this.staticModelsService.findModel(provider, model)?.name ?? loadedName ?? model;
  }

  /**
   * A text-completion-only provider is explained in the Model row's
   * description, title in bold, rather than in a separate warning box.
   */
  private applyTextOnlyProviderWarning(setting: Setting, variant: 'chat' | 'agent'): void {
    const provider = variant === 'agent' ? this.settings.agentProvider : this.settings.provider;
    if (!isTextOnlyProvider(provider)) return;
    const { title, message } = this.getTextOnlyProviderWarningCopy(provider, variant);
    setting.descEl.empty();
    setting.descEl.createEl('strong', { text: title });
    setting.descEl.createSpan({ text: ` ${message}` });
  }

  /**
   * Calm, factual copy for a text-completion-only provider. Antigravity mentions
   * BOTH limitations (no tools/agents AND no streaming); Perplexity keeps its
   * established search-focused wording.
   */
  private getTextOnlyProviderWarningCopy(
    provider: string | undefined,
    variant: 'chat' | 'agent'
  ): { title: string; message: string } {
    if (provider === 'google-gemini-cli') {
      return {
        title: 'Antigravity is text completions only',
        message: variant === 'agent'
          ? 'This provider can\'t call tools or agents, and replies arrive all at once (no streaming). Prompt actions and subagents run in text-only mode — use another cloud model for vault edits or other tool-driven work.'
          : 'This provider can\'t call tools or agents, and replies arrive all at once (no streaming). Use it for plain text chat; switch providers for agentic, tool-driven work.'
      };
    }

    // Perplexity (and any future search/text-only provider) — preserve prior copy.
    return {
      title: 'Perplexity cannot use Nexus tools',
      message: variant === 'agent'
        ? 'Prompt actions and subagents will run in text-only mode. Use another cloud model for vault edits or other tool-driven work.'
        : 'Chat and subagents will not receive tool schemas with Perplexity. Use it for search-heavy, text-only work.'
    };
  }

  // ========== IMAGES ==========

  private renderImages(itemsEl: HTMLElement): void {
    new Setting(itemsEl)
      .setName(COPY.provider)
      .addDropdown(dropdown => {
        // Every image adapter speaks requestUrl, so the list is the same on
        // desktop and mobile.
        const providers: Array<{ id: 'google' | 'openrouter' | 'openai'; name: string }> = [
          { id: 'google', name: 'Google AI' },
          { id: 'openai', name: 'OpenAI' },
          { id: 'openrouter', name: 'OpenRouter' }
        ];

        // A saved selection outside this list (older settings) falls back.
        if (!providers.some(p => p.id === this.settings.imageProvider)) {
          this.settings.imageProvider = providers[0].id;
          this.settings.imageModel = '';
        }

        for (const provider of providers) {
          dropdown.addOption(provider.id, provider.name);
        }

        dropdown.setValue(this.settings.imageProvider);
        dropdown.onChange((value) => {
          const provider = value as 'google' | 'openrouter' | 'openai';
          this.settings.imageProvider = provider;
          void this.imageService.getModelsForProvider(provider).then(models => {
            if (provider !== this.settings.imageProvider) return;
            this.settings.imageModel = models[0]?.id || '';
            this.modelNames.image = models[0]?.name;
            this.notifyChange();
            this.redrawGroups([FOLD_IDS.images]);
          });
        });
      });

    // Model (async — populate from adapter)
    const provider = this.settings.imageProvider;
    new Setting(itemsEl)
      .setName(COPY.model)
      .addDropdown(async dropdown => {
        const models = await this.imageService.getModelsForProvider(provider);
        if (provider !== this.settings.imageProvider) return;

        if (models.length === 0) {
          dropdown.addOption('', 'No models available');
        } else {
          sortModelsNewestFirst(models, m => ({ provider, id: m.id })).forEach(m => {
            dropdown.addOption(m.id, m.name);
          });

          // A missing model falls back to the first; saved with the next real edit.
          if (!models.some(m => m.id === this.settings.imageModel)) {
            this.settings.imageModel = models[0].id;
          }
          dropdown.setValue(this.settings.imageModel);
          this.modelNames.image = models.find(m => m.id === this.settings.imageModel)?.name;
          this.updateSummaries();
        }

        dropdown.onChange((value) => {
          this.settings.imageModel = value;
          this.modelNames.image = models.find(m => m.id === value)?.name;
          this.notifyChange();
        });
      });
  }

  // ========== CONTEXT ==========

  private renderContext(itemsEl: HTMLElement): void {
    new Setting(itemsEl)
      .setName(COPY.workspace)
      .addDropdown(dropdown => {
        dropdown.addOption('', COPY.none);
        this.config.options.workspaces.forEach(w => {
          dropdown.addOption(w.id, w.name);
        });
        dropdown.setValue(this.settings.workspaceId || '');
        dropdown.onChange((value) => {
          this.settings.workspaceId = value || null;
          if (this.surface === 'chat') {
            // A workflow belongs to its workspace, so a new workspace starts with none.
            this.settings.workflowId = null;
            this.notifyChange();
            this.redrawGroups([FOLD_IDS.context]);
            return;
          }
          this.notifyChange();
          this.syncWorkspacePrompt(value);
        });
      });

    if (this.surface === 'chat') {
      new Setting(itemsEl)
        .setName(COPY.workflow)
        .setDesc(COPY.workflowDesc)
        .addDropdown(dropdown => {
          dropdown.addOption('', COPY.none);
          const workspace = this.config.options.workspaces.find(item => item.id === this.settings.workspaceId);
          for (const workflow of workspace?.context?.workflows ?? []) dropdown.addOption(workflow.id, workflow.name);
          dropdown.setValue(this.settings.workflowId || '');
          dropdown.onChange(value => { this.settings.workflowId = value || null; this.notifyChange(); });
        });
    }

    new Setting(itemsEl)
      .setName(COPY.prompt)
      .addDropdown(dropdown => {
        dropdown.addOption('', COPY.none);
        this.config.options.prompts.forEach(p => {
          dropdown.addOption(p.id, p.name);
        });
        dropdown.setValue(this.settings.promptId || '');
        dropdown.onChange((value) => {
          this.settings.promptId = value || null;
          this.notifyChange();
        });
      });

    new Setting(itemsEl)
      .setName(COPY.contextNotes)
      .addButton(button => button
        .setButtonText(COPY.addNote)
        .onClick(() => { void this.openNotePicker(); }));

    this.settings.contextNotes.forEach((notePath, index) => {
      const name = noteBasename(notePath);
      const row = new Setting(itemsEl).setClass('nexus-note-row');
      row.nameEl.empty();
      setIcon(row.nameEl.createSpan({ cls: 'nexus-note-icon' }), 'file-text');
      row.nameEl.createSpan({ text: name });
      row.nameEl.setAttribute('title', notePath);
      row.addExtraButton(button => button
        .setIcon('x')
        .setTooltip(COPY.removeNote(name))
        .onClick(() => {
          this.settings.contextNotes.splice(index, 1);
          this.notifyChange();
          this.redrawGroups([FOLD_IDS.context]);
        }));
    });
  }

  private syncWorkspacePrompt(workspaceId: string | null): void {
    if (!workspaceId) return;

    const workspace = this.config.options.workspaces.find(w => w.id === workspaceId);
    // Same precedence as WorkspacePromptResolver: the top-level binding first,
    // then the deprecated context.dedicatedAgent. Either holds a prompt name or ID.
    const promptId = workspace?.dedicatedAgentId || workspace?.context?.dedicatedAgent?.agentId;
    if (!promptId) return;
    const prompt = this.config.options.prompts.find(p => p.id === promptId || p.name === promptId);
    if (prompt) {
      this.settings.promptId = prompt.id;
      this.notifyChange();
      this.redrawGroups([FOLD_IDS.context]);
    }
  }

  private contextSummary(): string {
    const workspace = this.config.options.workspaces.find(w => w.id === this.settings.workspaceId);
    const prompt = this.config.options.prompts.find(p => p.id === this.settings.promptId || p.name === this.settings.promptId);
    return contextSummary({
      workspaceName: workspace?.name ?? null,
      promptName: prompt?.name ?? this.settings.promptId,
      noteCount: this.settings.contextNotes.length
    });
  }

  private async openNotePicker(): Promise<void> {
    const selectedPaths = await FilePickerRenderer.openModal(this.config.app, {
      title: 'Select Context Notes',
      excludePaths: this.settings.contextNotes
    });

    if (selectedPaths.length > 0) {
      this.settings.contextNotes.push(...selectedPaths);
      this.notifyChange();
      this.redrawGroups([FOLD_IDS.context]);
    }
  }

  // ========== HELPERS ==========

  private getAppsSettings(): AppsSettings | undefined {
    const plugin = getNexusPlugin(this.config.app) as PluginWithAppSettings | null;
    return plugin?.settings?.settings?.apps;
  }

  private getProviderDisplayName(providerId: string): string {
    const config = this.config.llmProviderSettings.providers[providerId];
    if (config?.driverKind === 'openai-compatible') {
      return config.openaiCompatible?.displayName || 'OpenAI-compatible';
    }
    return ProviderUtils.getProviderDisplayName(providerId);
  }

  private async getDefaultModelForProvider(providerId: string): Promise<string> {
    try {
      const models = await this.providerManager.getModelsForProvider(providerId);
      return models[0]?.id || '';
    } catch {
      return '';
    }
  }

  getSettings(): ChatSettings {
    return { ...this.settings, contextNotes: [...this.settings.contextNotes] };
  }
}

function noteBasename(path: string): string {
  const file = path.split('/').pop() || path;
  return file.replace(/\.md$/i, '');
}
