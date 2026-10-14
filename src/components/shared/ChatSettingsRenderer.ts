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
 *
 * The selected model decides its rows: Thinking appears only for models that
 * reason and offers only the levels the model distinguishes; Creativity is
 * disabled for models that set their own temperature; Context window snaps to
 * preset sizes up to the model's maximum, and a newly picked model starts at
 * that maximum. The Subagents fold applies the same rules to the subagent
 * model (or, when none is set, the cloud chat model subagents fall back to).
 *
 * A chat model counts only when its provider can be used: a fresh install
 * carries a default model for a provider nobody has set up, and the rows and
 * summaries must not describe it. Without a model, Thinking is hidden and
 * Creativity and Context window show a disabled placeholder.
 */

import { App, Component, EventRef, Setting, setIcon } from 'obsidian';
import { LLMProviderManager } from '../../services/llm/providers/ProviderManager';
import { StaticModelsService } from '../../services/StaticModelsService';
import { ImageGenerationService } from '../../services/llm/ImageGenerationService';
import { getImageModelDisplayName } from '../../services/llm/imageModelNames';
import { LLMProviderSettings } from '../../types/llm/ProviderTypes';
import type { AppsSettings } from '../../types/apps/AppTypes';
import { isTextOnlyProvider } from '../../services/llm/utils/ToolSchemaSupport';
import { FilePickerRenderer } from '../workspace/FilePickerRenderer';
import { isProviderCompatible } from '../../utils/platform';
import { LLMSettingsNotifier } from '../../services/llm/LLMSettingsNotifier';
import { renderModelSetting, renderProviderSetting, toDisplayProvider, type ModelDropdownConfig } from './ModelDropdownRenderer';
import { ProviderUtils } from '../../ui/chat/utils/ProviderUtils';
import { getNexusPlugin } from '../../utils/pluginLocator';
import { sortModelsNewestFirst } from '../../utils/modelOrdering';
import { getContextWindowOverrideKey, resolveContextWindowLimit } from '../../ui/chat/utils/ContextWindowSettings';
import { normalizeThinkingEffortForModel } from '../../services/llm/utils/thinkingLevels';
import { contextWindowStopIndex, contextWindowStops } from './chatSettings/contextWindowStops';
import { resolveSubagentTarget } from './chatSettings/subagentTarget';
import { isLocalProvider } from '../../services/llm/utils/SubagentModelResolver';
import { ModelCapabilityResolver, type ModelCapabilities } from './chatSettings/modelCapabilities';
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
  subagentsSummary,
  tuningSummary
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

/** The chat model (top block, Chat options) or the subagent model (Subagents fold). */
type ModelVariant = 'chat' | 'agent';

interface ModelTarget {
  provider?: string;
  model?: string;
}

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
  /** The image provider whose model list last came back empty, if any. */
  private imageProviderWithoutModels: string | null = null;
  // Registry capabilities plus context windows discovered at runtime (Ollama, LM Studio).
  private capabilities: ModelCapabilityResolver;

  constructor(container: HTMLElement, config: ChatSettingsRendererConfig) {
    this.container = container;
    this.config = config;
    this.settings = {
      ...config.initialSettings,
      contextNotes: [...(config.initialSettings.contextNotes ?? [])],
      contextWindowOverrides: { ...(config.initialSettings.contextWindowOverrides ?? config.llmProviderSettings.contextWindowOverrides ?? {}) },
      agentContextWindowOverrides: { ...(config.initialSettings.agentContextWindowOverrides ?? config.llmProviderSettings.agentContextWindowOverrides ?? {}) }
    };
    this.staticModelsService = StaticModelsService.getInstance();
    this.capabilities = new ModelCapabilityResolver(this.staticModelsService, () => this.providerManager);
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
      this.imageProviderWithoutModels = null;
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
        el => this.renderImages(el), () => this.imagesFoldSummary()),
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

  /**
   * Providers shown in the Provider dropdowns. Merged sign-in providers
   * (ChatGPT, Claude Code, Antigravity CLI) appear under their API provider.
   */
  private getEnabledProviders(): string[] {
    const settings = this.config.llmProviderSettings;
    const providers = new Set<string>();
    for (const id of Object.keys(settings.providers)) {
      if (isProviderUsable(settings, id)) providers.add(toDisplayProvider(id) ?? id);
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

  private modelDropdownConfig(variant: ModelVariant): ModelDropdownConfig {
    const isAgent = variant === 'agent';
    return {
      getProviders: () => isAgent
        ? this.getEnabledProviders().filter(id => !isLocalProvider(id))
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
        // In a chat, a newly picked model starts at its full window. On
        // Defaults every per-model limit is already saved and is that model's
        // own preference, so picking a model keeps it.
        if (this.surface !== 'defaults') this.clearContextWindowOverride(variant);
      },
      noProvidersText: isAgent ? COPY.noCloudProviders : COPY.noProviders,
      inheritOptionText: isAgent && this.subagentsCanInheritChat() ? COPY.sameAsChat : undefined,
      getUnsetModelText: isAgent ? () => this.inheritedSubagentModelText() : undefined,
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

  // ========== MODEL CAPABILITIES ==========

  /**
   * The model a variant's tuning rows describe. Subagents use their own model
   * when one is set; otherwise they run on the chat model when it is a cloud
   * model (the runtime precedence), so the rows and summary describe that one.
   */
  private modelTarget(variant: ModelVariant): ModelTarget {
    const chat = this.chatTarget();
    if (variant === 'chat') return chat;
    const { provider, model } = resolveSubagentTarget({
      ...this.settings,
      provider: chat.provider ?? '',
      model: chat.model ?? ''
    });
    return { provider, model };
  }

  /**
   * The chat model, or nothing when none is picked or its provider cannot be
   * used (no key, turned off). The runtime skips such a model too.
   */
  private chatTarget(): ModelTarget {
    const { provider, model } = this.settings;
    return provider && model && isProviderUsable(this.config.llmProviderSettings, provider) ? { provider, model } : {};
  }

  private hasModel(variant: ModelVariant): boolean {
    const { provider, model } = this.modelTarget(variant);
    return !!(provider && model);
  }

  private hasAgentModel(): boolean {
    return !!(this.settings.agentProvider && this.settings.agentModel);
  }

  private capabilitiesFor(variant: ModelVariant): ModelCapabilities {
    const { provider, model } = this.modelTarget(variant);
    return this.capabilities.get(provider, model, () =>
      this.redrawGroups([FOLD_IDS.chatOptions, FOLD_IDS.subagents]));
  }

  private modelNameFor(variant: ModelVariant): string | undefined {
    const { provider, model } = this.modelTarget(variant);
    const loaded = variant === 'agent' && this.hasAgentModel() ? this.modelNames.agent : this.modelNames.chat;
    return this.modelDisplayName(provider, model, loaded);
  }

  private thinkingFor(variant: ModelVariant): ChatSettings['thinking'] {
    if (variant === 'chat') return this.settings.thinking;
    return this.settings.agentThinking ?? { enabled: false, effort: 'medium' };
  }

  /**
   * The Thinking dropdown (Off plus the levels this model distinguishes).
   * Present only when the model can reason; Off keeps the stored effort so
   * switching back restores it.
   */
  private renderThinkingSetting(itemsEl: HTMLElement, variant: ModelVariant): void {
    const isAgent = variant === 'agent';
    const { provider, model } = this.modelTarget(variant);
    if (!this.capabilitiesFor(variant).supportsThinking) return;

    const current = this.thinkingFor(variant);
    new Setting(itemsEl)
      .setName(COPY.thinking)
      .addDropdown(dropdown => {
        dropdown.addOption('off', THINKING_LABELS.off);
        for (const level of getThinkingLevels(provider, model)) {
          dropdown.addOption(level, THINKING_LABELS[level]);
        }
        dropdown.setValue(thinkingToOption(current, provider, model));
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
    this.renderCreativitySetting(itemsEl, 'chat');
    this.renderContextWindowSetting(itemsEl, 'chat');
    if (this.surface === 'chat') this.renderWebSearchSetting(itemsEl);
  }

  /** The fold whose listeners own a variant's tuning rows. */
  private tuningGroup(variant: ModelVariant): string {
    return variant === 'agent' ? FOLD_IDS.subagents : FOLD_IDS.chatOptions;
  }

  private temperatureFor(variant: ModelVariant): number {
    if (variant === 'agent') return this.settings.agentTemperature ?? this.settings.temperature;
    return this.settings.temperature;
  }

  /**
   * Creativity follows the model: a model that rejects temperature gets a
   * disabled row saying so, with "—" for the value. The stored value is kept
   * for the next model that accepts it.
   */
  private renderCreativitySetting(itemsEl: HTMLElement, variant: ModelVariant): void {
    if (!this.hasModel(variant)) {
      this.renderNoModelTuningRow(itemsEl, COPY.creativity, variant);
      return;
    }
    const events = this.events(this.tuningGroup(variant));
    const supportsTemperature = this.capabilitiesFor(variant).supportsSamplingParams;
    const modelName = this.modelNameFor(variant);
    const setting = new Setting(itemsEl).setName(COPY.creativity);

    if (!supportsTemperature) {
      setting.setDesc(COPY.creativityFixedDesc(modelName ?? 'This model'));
      setting.setDisabled(true);
      setting.addSlider(slider => {
        slider
          .setLimits(0, 1, 0.1)
          .setValue(this.temperatureFor(variant))
          .setDisabled(true);
        bindSliderReadout(events, setting, slider, () => COPY.creativityFixedReadout, {
          ariaValueText: () => COPY.fixedTemperature
        });
        return slider;
      });
      return;
    }

    setting.setDesc(COPY.creativityDesc);
    setting.addSlider(slider => {
      slider
        .setLimits(0, 1, 0.1)
        .setValue(this.temperatureFor(variant));
      bindSliderReadout(events, setting, slider, formatTemperature);
      slider.onChange((value: number) => {
        if (variant === 'agent') this.settings.agentTemperature = value;
        else this.settings.temperature = value;
        this.notifyChange();
      });
      return slider;
    });
  }

  /**
   * Creativity or Context window before a model is picked: nothing to tune
   * and no value to show, so a disabled slider reading "—".
   */
  private renderNoModelTuningRow(itemsEl: HTMLElement, name: string, variant: ModelVariant): void {
    const setting = new Setting(itemsEl)
      .setName(name)
      .setDesc(COPY.noModelTuningDesc);
    setting.setDisabled(true);
    setting.addSlider(slider => {
      slider.setLimits(0, 1, 1).setValue(0).setDisabled(true);
      bindSliderReadout(this.events(this.tuningGroup(variant)), setting, slider, () => COPY.noValueReadout, {
        ariaValueText: () => COPY.noModelValueText
      });
      return slider;
    });
  }

  private overridesFor(variant: ModelVariant): Record<string, number> {
    if (variant === 'agent') {
      if (!this.settings.agentContextWindowOverrides) this.settings.agentContextWindowOverrides = {};
      return this.settings.agentContextWindowOverrides;
    }
    if (!this.settings.contextWindowOverrides) this.settings.contextWindowOverrides = {};
    return this.settings.contextWindowOverrides;
  }

  /** Forget the pending limit for the variant's selected model, so it shows its maximum. */
  private clearContextWindowOverride(variant: ModelVariant): void {
    const provider = variant === 'agent' ? this.settings.agentProvider : this.settings.provider;
    const model = variant === 'agent' ? this.settings.agentModel : this.settings.model;
    if (!provider || !model) return;
    delete this.overridesFor(variant)[getContextWindowOverrideKey(provider, model)];
  }

  /** The budget a variant will use: the override when set, else the model maximum. */
  private getContextBudget(variant: ModelVariant): number | undefined {
    const advertised = this.capabilitiesFor(variant).contextWindow;
    if (!advertised) return undefined;
    const { provider, model } = this.modelTarget(variant);
    if (!provider || !model) return undefined;
    const maximum = resolveContextWindowLimit(advertised);
    return resolveContextWindowLimit(maximum, this.overridesFor(variant)[getContextWindowOverrideKey(provider, model)]);
  }

  /**
   * Context window snaps to preset sizes below the model's maximum plus the
   * maximum itself. A model with one stop gets a disabled slider. A saved
   * size between stops (older settings) is shown as saved until moved.
   */
  private renderContextWindowSetting(itemsEl: HTMLElement, variant: ModelVariant): void {
    if (!this.hasModel(variant)) {
      this.renderNoModelTuningRow(itemsEl, COPY.contextWindow, variant);
      return;
    }
    const advertised = this.capabilitiesFor(variant).contextWindow;
    const { provider, model } = this.modelTarget(variant);
    if (!advertised || !provider || !model) return;
    const maximum = resolveContextWindowLimit(advertised);
    if (maximum <= 0) return;

    const stops = contextWindowStops(maximum);
    const key = getContextWindowOverrideKey(provider, model);
    const selected = resolveContextWindowLimit(maximum, this.overridesFor(variant)[key]);
    const onStop = stops.includes(selected);
    const setting = new Setting(itemsEl)
      .setName(COPY.contextWindow)
      .setDesc(COPY.contextWindowDesc);

    setting.addSlider(slider => {
      slider
        .setLimits(0, stops.length - 1, 1)
        .setValue(contextWindowStopIndex(stops, selected));
      if (stops.length < 2) slider.setDisabled(true);
      const stopAt = (index: number): number => stops[Math.max(0, Math.min(stops.length - 1, Math.round(index)))];
      const format = (index: number): string => formatContextWindow(stopAt(index));
      bindSliderReadout(this.events(this.tuningGroup(variant)), setting, slider, format, {
        ariaValueText: index => COPY.contextWindowValueText(format(index)),
        initialText: onStop ? undefined : formatContextWindow(selected),
        cls: 'nexus-ctx-value'
      });
      if (!onStop) {
        slider.sliderEl.setAttribute('aria-valuetext', COPY.contextWindowValueText(formatContextWindow(selected)));
      }
      slider.onChange(index => {
        const limit = stopAt(index);
        const overrides = this.overridesFor(variant);
        if (limit === maximum) delete overrides[key];
        else overrides[key] = limit;
        this.notifyChange();
      });
      return slider;
    });
  }

  private supportsWebSearch(): boolean {
    return ['anthropic', 'openai', 'google', 'openrouter'].includes(this.settings.provider);
  }

  /** Google models before Gemini 3 get an info row instead of a toggle. */
  private isGeminiWithoutWebSearch(): boolean {
    return this.settings.provider === 'google' && !this.settings.model.startsWith('gemini-3');
  }

  /** The Web search toggle is offered: only then does the summary report it. */
  private hasWebSearchToggle(): boolean {
    return this.surface === 'chat' && this.supportsWebSearch() && !this.isGeminiWithoutWebSearch();
  }

  private renderWebSearchSetting(itemsEl: HTMLElement): void {
    if (!this.supportsWebSearch()) return;
    if (this.isGeminiWithoutWebSearch()) {
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
    // No model, no capabilities: say what is missing rather than invent them.
    if (!this.hasModel('chat')) return COPY.pickModelFirst;
    return chatOptionsSummary({
      temperature: this.settings.temperature,
      supportsTemperature: this.capabilitiesFor('chat').supportsSamplingParams,
      contextWindow: this.getContextBudget('chat'),
      webSearch: this.hasWebSearchToggle() ? this.settings.webSearch === true : undefined
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
    this.renderCreativitySetting(itemsEl, 'agent');
    this.renderContextWindowSetting(itemsEl, 'agent');
  }

  /**
   * Whether an empty subagent provider means "run on the chat model". On
   * Defaults it always does. In a chat it means "use the default subagent
   * model", which is the chat model only when no default is saved.
   */
  private subagentsCanInheritChat(): boolean {
    if (this.surface === 'defaults') return true;
    const saved = this.config.llmProviderSettings.agentModel;
    return !(saved?.provider && saved.model);
  }

  /** The subagent Model row while "Same as chat" is selected. */
  private inheritedSubagentModelText(): string | undefined {
    if (!this.subagentsCanInheritChat()) return undefined;
    const name = this.modelNameFor('agent');
    return name ? COPY.sameAsChatModel(name) : undefined;
  }

  /** "<model> · <thinking> · <creativity> · <window>" for the model subagents will run on. */
  private subagentsSummary(): string {
    const { provider, model } = this.modelTarget('agent');
    if (!provider || !model) return this.subagentsWithoutModelSummary();
    const capabilities = this.capabilitiesFor('agent');
    const thinking = this.thinkingFor('agent');
    return subagentsSummary({
      modelName: this.modelNameFor('agent'),
      // The level that is really sent, when the model folds the stored one onto a neighbour.
      thinking: capabilities.supportsThinking
        ? { enabled: thinking.enabled, effort: normalizeThinkingEffortForModel(provider, model, thinking.effort) }
        : null,
      tuning: provider && model
        ? tuningSummary({
          temperature: this.temperatureFor('agent'),
          supportsTemperature: capabilities.supportsSamplingParams,
          contextWindow: this.getContextBudget('agent')
        })
        : []
    });
  }

  /**
   * No subagent model, and no usable cloud chat model to run on. Without any
   * cloud provider nothing can run them; otherwise the runtime picks a cloud
   * provider. Either way, never name a model nobody configured.
   */
  private subagentsWithoutModelSummary(): string {
    const hasCloudProvider = this.getEnabledProviders().some(id => !isLocalProvider(id));
    return hasCloudProvider ? COPY.notSet : COPY.noModel;
  }

  private modelDisplayName(provider: string | undefined, model: string | undefined, loadedName?: string): string | undefined {
    if (!provider || !model) return undefined;
    return this.capabilities.get(provider, model).name ?? loadedName ?? model;
  }

  /**
   * A text-completion-only provider is explained in the Model row's
   * description, title in bold, rather than in a separate warning box.
   */
  private applyTextOnlyProviderWarning(setting: Setting, variant: ModelVariant): void {
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

  /**
   * The Images summary. A provider with no key (or turned off) has no adapter
   * and lists no models, so naming the saved model there — the catalog knows
   * "Nano Banana 2" without a key — described a setting that cannot run.
   */
  private imagesFoldSummary(): string {
    const ready = this.imageService.getInitializedProviders();
    const provider = this.settings.imageProvider;
    return imagesSummary({
      modelName: this.imageModelName(),
      anyProviderUsable: ready.length > 0,
      providerUsable: ready.includes(provider) && this.imageProviderWithoutModels !== provider
    });
  }

  /** The image model's name: as listed once loaded, else from the catalog, else its id. */
  private imageModelName(): string | undefined {
    const { imageProvider, imageModel } = this.settings;
    return this.modelNames.image
      ?? getImageModelDisplayName(imageProvider, imageModel)
      ?? (imageModel || undefined);
  }

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

        this.imageProviderWithoutModels = models.length === 0 ? provider : null;
        if (models.length === 0) {
          dropdown.addOption('', 'No models available');
          this.modelNames.image = undefined;
          this.updateSummaries();
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

/** Whether a provider, by its own id, is set up well enough to send a request. */
function isProviderUsable(settings: LLMProviderSettings, id: string): boolean {
  const config = settings.providers[id];
  if (!config?.enabled) return false;

  if (id === 'openai-codex' || id === 'github-copilot') {
    return !!(config.oauth?.connected && config.apiKey);
  }
  if (id === 'anthropic-claude-code' || id === 'google-gemini-cli') {
    return !!config.oauth?.connected;
  }

  if (!isProviderCompatible(config.driverKind ?? id)) return false;
  if (config.driverKind === 'openai-compatible') return !!config.openaiCompatible?.baseUrl.trim();
  if (id === 'webllm') return true;
  return !!config.apiKey;
}

function noteBasename(path: string): string {
  const file = path.split('/').pop() || path;
  return file.replace(/\.md$/i, '');
}
