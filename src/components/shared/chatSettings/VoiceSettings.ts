/**
 * The Voice fold: transcription, read aloud and live voice.
 *
 * This is the only voice settings implementation. Defaults and Chat settings
 * both render it through ChatSettingsRenderer; it edits only the renderer's
 * settings object, and each surface decides how to persist that (Defaults
 * through its save queue, Chat settings on Save). The Defaults-only "Saved
 * audio folder" row is supplied by the host.
 */

import { Setting } from 'obsidian';
import type { LLMProviderManager } from '../../../services/llm/providers/ProviderManager';
import {
  buildSpeechProviderAvailability,
  getSpeechModel,
  resolveDefaultSpeechSelection,
  type SpeechAppCapabilityStates,
  type SpeechProvider,
  type SpeechProviderAvailability,
} from '../../../services/llm/types/SpeechTypes';
import {
  buildRealtimeVoiceProviderAvailability,
  getRealtimeVoiceModel,
  resolveDefaultRealtimeVoiceSelection,
  type RealtimeAppCapabilityStates,
  type RealtimeVoiceProviderAvailability,
} from '../../../services/llm/types/RealtimeVoiceTypes';
import type { LLMProviderSettings } from '../../../types/llm/ProviderTypes';
import type { AppsSettings } from '../../../types/apps/AppTypes';
import {
  getIngestCapabilityOptions,
  normalizeIngestSelection,
  type IngestProviderOption,
} from '../../../agents/ingestManager/tools/services/IngestCapabilityService';
import { renderIngestModelDropdowns } from '../IngestModelDropdownRenderer';
import { getTranscriptionModel } from '../../../services/llm/types/VoiceTypes';
import { VoiceCatalogService } from '../../../services/readAloud/VoiceCatalogService';
import { SpeechModelCatalogService } from '../../../services/readAloud/SpeechModelCatalogService';
import { sortModelsNewestFirst } from '../../../utils/modelOrdering';
import { COPY, VOICE_COPY } from './copy';
import { voiceSummary } from './sectionSummaries';
import type { ChatSettings, SettingsSurface } from './types';

/** The Defaults-only saved-audio folder row. */
export interface VoiceAudioFolderOption {
  getValue(): string;
  placeholder: string;
  onChange(value: string): void;
}

export interface VoiceSettingsHost {
  readonly surface: SettingsSurface;
  readonly settings: ChatSettings;
  readonly llmProviderSettings: LLMProviderSettings;
  readonly providerManager: LLMProviderManager | null;
  notifyChange(): void;
  setSummary(summary: string): void;
  /** Re-render the Voice fold (used once transcription options load). */
  redraw(): void;
  getProviderDisplayName(providerId: string): string;
  getAppsSettings(): AppsSettings | undefined;
  audioFolder?: VoiceAudioFolderOption;
}

type CapabilityState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; providers: IngestProviderOption[] }
  | { status: 'failed' };

/** A Setting used as a small uppercase subheading inside a fold. */
export function addSubhead(itemsEl: HTMLElement, text: string): Setting {
  return new Setting(itemsEl).setName(text).setClass('nexus-subhead');
}

export class VoiceSettings {
  private transcription: CapabilityState = { status: 'idle' };
  private readonly voiceCatalog = new VoiceCatalogService();
  private readonly speechModelCatalog = new SpeechModelCatalogService();
  private renderToken = 0;
  private names: { transcriptionModel?: string; speechModel?: string; speechVoice?: string } = {};
  private speechProviderSetting: Setting | null = null;
  private realtimeProviderSetting: Setting | null = null;
  private realtimeAvailable = false;

  constructor(
    private readonly host: VoiceSettingsHost,
    private readonly loadTranscriptionProviders: () => Promise<IngestProviderOption[]> = async () =>
      (await getIngestCapabilityOptions(host.providerManager)).transcriptionProviders
  ) {}

  private get settings(): ChatSettings {
    return this.host.settings;
  }

  render(itemsEl: HTMLElement): void {
    const token = ++this.renderToken;
    this.speechProviderSetting = null;
    this.realtimeProviderSetting = null;

    addSubhead(itemsEl, VOICE_COPY.transcription);
    this.renderTranscription(itemsEl);

    addSubhead(itemsEl, VOICE_COPY.readAloud);
    this.renderSpeech(itemsEl, token);
    if (this.host.audioFolder) this.renderAudioFolder(itemsEl, this.host.audioFolder);

    addSubhead(itemsEl, VOICE_COPY.liveVoice);
    this.renderRealtime(itemsEl);

    this.updateWarnings();
    this.updateSummary();
  }

  /**
   * Model names as listed once loaded; before that, from the static
   * catalogs, and the raw id only for a model neither knows.
   */
  getSummary(): string {
    const { transcriptionProvider, transcriptionModel, speechProvider, speechModel } = this.settings;
    return voiceSummary({
      transcriptionModel: this.names.transcriptionModel
        ?? (transcriptionProvider && transcriptionModel
          ? getTranscriptionModel(transcriptionProvider, transcriptionModel)?.name
          : undefined)
        ?? transcriptionModel,
      readAloudModel: this.names.speechModel
        ?? getSpeechModel(speechProvider, speechModel)?.name
        ?? speechModel,
      voice: this.names.speechVoice
    });
  }

  private updateSummary(): void {
    this.host.setSummary(this.getSummary());
  }

  // ---------- Transcription ----------

  private renderTranscription(itemsEl: HTMLElement): void {
    const state = this.transcription;
    if (state.status === 'idle' || state.status === 'loading') {
      new Setting(itemsEl).setName(COPY.provider).setDesc(VOICE_COPY.transcriptionLoading);
      if (state.status === 'idle') this.loadTranscription();
      return;
    }
    if (state.status === 'failed') {
      new Setting(itemsEl).setName(COPY.provider).setDesc(VOICE_COPY.transcriptionUnavailable);
      return;
    }

    const providers = state.providers;
    const normalized = normalizeIngestSelection(
      providers,
      this.settings.transcriptionProvider,
      this.settings.transcriptionModel
    );
    // Automatic corrections update the edited settings without counting as a
    // change: they are saved with the next real edit (or on Save in a chat),
    // so merely opening settings never writes data.json.
    this.settings.transcriptionProvider = normalized.provider;
    this.settings.transcriptionModel = normalized.model;
    this.names.transcriptionModel = this.transcriptionModelName(providers);

    renderIngestModelDropdowns(itemsEl, {
      labelPrefix: VOICE_COPY.transcription,
      description: VOICE_COPY.transcriptionProviderDesc,
      providers,
      getSelection: () => this.settings.transcriptionProvider && this.settings.transcriptionModel
        ? { provider: this.settings.transcriptionProvider, model: this.settings.transcriptionModel }
        : undefined,
      onChange: (provider, model) => {
        this.settings.transcriptionProvider = provider;
        this.settings.transcriptionModel = model;
        this.names.transcriptionModel = this.transcriptionModelName(providers);
        this.host.notifyChange();
        this.updateSummary();
      },
      providerSettingName: COPY.provider,
      modelSettingName: COPY.model
    });
  }

  private transcriptionModelName(providers: IngestProviderOption[]): string | undefined {
    const provider = providers.find(item => item.id === this.settings.transcriptionProvider);
    const model = provider?.models.find(item => item.id === this.settings.transcriptionModel);
    return model?.name ?? this.settings.transcriptionModel;
  }

  private loadTranscription(): void {
    this.transcription = { status: 'loading' };
    void this.loadTranscriptionProviders().then(providers => {
      this.transcription = { status: 'ready', providers };
    }).catch(() => {
      this.transcription = { status: 'failed' };
    }).then(() => {
      this.host.redraw();
    });
  }

  // ---------- Read aloud ----------

  private getSpeechAppStates(): SpeechAppCapabilityStates {
    const elevenLabs = this.host.getAppsSettings()?.apps.elevenlabs;
    return elevenLabs
      ? { elevenlabs: { enabled: elevenLabs.enabled, configured: !!elevenLabs.credentials.apiKey?.trim() } }
      : {};
  }

  private getRealtimeAppStates(): RealtimeAppCapabilityStates {
    const elevenLabs = this.host.getAppsSettings()?.apps.elevenlabs;
    return elevenLabs
      ? { elevenlabs: { enabled: elevenLabs.enabled, configured: !!elevenLabs.credentials.apiKey?.trim() } }
      : {};
  }

  private speechAvailability(): SpeechProviderAvailability[] {
    return buildSpeechProviderAvailability(this.host.llmProviderSettings, this.getSpeechAppStates());
  }

  /** The settings' pick, or the same automatic pick read aloud makes when none is set. */
  private speechSelection(): { provider?: string; model?: string; voice?: string } {
    if (this.settings.speechProvider) {
      const availability = this.speechAvailability().find(item => item.provider === this.settings.speechProvider);
      return {
        provider: this.settings.speechProvider,
        model: this.settings.speechModel || availability?.models?.[0]?.id,
        voice: this.settings.speechVoice
      };
    }
    const auto = resolveDefaultSpeechSelection(
      { ...this.host.llmProviderSettings, defaultSpeechModel: undefined },
      this.speechAvailability()
    );
    return { provider: auto.provider, model: auto.model, voice: this.settings.speechVoice ?? auto.voice };
  }

  private renderSpeech(itemsEl: HTMLElement, token: number): void {
    let modelDropdown: HTMLSelectElement | null = null;
    let voiceDropdown: HTMLSelectElement | null = null;
    let modelRequestId = 0;
    let voiceRequestId = 0;
    const stale = (): boolean => token !== this.renderToken;

    const markUser = (): void => {
      this.settings.speechSource = 'user';
    };

    const updateVoiceOptions = async (): Promise<void> => {
      if (!voiceDropdown) return;
      const requestId = ++voiceRequestId;
      const selection = this.speechSelection();

      voiceDropdown.empty();
      if (selection.provider === 'elevenlabs') {
        voiceDropdown.createEl('option', { value: '', text: 'Loading voices...' });
        voiceDropdown.disabled = true;
      }

      const voices = await this.voiceCatalog.getVoices(selection.provider, selection.model, {
        llmSettings: this.host.llmProviderSettings,
        appsSettings: this.host.getAppsSettings()
      }).catch(() => []);

      if (requestId !== voiceRequestId || !voiceDropdown || stale()) return;

      voiceDropdown.empty();
      voiceDropdown.createEl('option', { value: '', text: 'Provider default' });
      voices.forEach(voice => {
        voiceDropdown?.createEl('option', { value: voice.id, text: voice.name });
      });
      if (selection.voice && !voices.some(voice => voice.id === selection.voice)) {
        voiceDropdown.createEl('option', { value: selection.voice, text: `${selection.voice} (unavailable)` });
      }
      voiceDropdown.disabled = !selection.provider || !selection.model;
      voiceDropdown.value = selection.voice || '';
      this.names.speechVoice = selection.voice
        ? voices.find(voice => voice.id === selection.voice)?.name ?? selection.voice
        : undefined;
      this.updateSummary();
    };

    const updateModelOptions = async (): Promise<void> => {
      if (!modelDropdown) return;
      const requestId = ++modelRequestId;
      const selection = this.speechSelection();
      const providerAvailability = this.speechAvailability().find(item => item.provider === selection.provider);
      const providerUsable = providerAvailability?.enabled === true && providerAvailability.configured === true;

      modelDropdown.empty();
      if (!selection.provider) {
        modelDropdown.createEl('option', { value: '', text: 'Select a speech provider first' });
        modelDropdown.disabled = true;
        void updateVoiceOptions();
        return;
      }
      if (selection.provider === 'openrouter') {
        modelDropdown.createEl('option', { value: '', text: 'Loading OpenRouter speech models...' });
        modelDropdown.disabled = true;
      }

      const models = await this.speechModelCatalog.getModels(
        selection.provider as SpeechProvider,
        this.host.llmProviderSettings
      ).catch(() => providerAvailability?.models ?? []);

      if (requestId !== modelRequestId || !modelDropdown || stale()) return;

      modelDropdown.empty();
      if (models.length === 0) {
        modelDropdown.createEl('option', { value: '', text: 'No speech models available' });
        modelDropdown.disabled = true;
        void updateVoiceOptions();
        return;
      }

      sortModelsNewestFirst(models, model => ({ provider: selection.provider || '', id: model.id })).forEach(model => {
        modelDropdown?.createEl('option', { value: model.id, text: model.name });
      });
      if (selection.model && !models.some(model => model.id === selection.model)) {
        modelDropdown.createEl('option', { value: selection.model, text: `${selection.model} (unavailable)` });
      }

      const nextModel = selection.model && models.some(model => model.id === selection.model)
        ? selection.model
        : models[0]?.id || '';
      modelDropdown.disabled = !providerUsable;
      modelDropdown.value = nextModel;
      this.names.speechModel = models.find(model => model.id === nextModel)?.name ?? (nextModel || undefined);

      this.settings.speechProvider = selection.provider;
      this.settings.speechModel = nextModel || undefined;
      this.updateWarnings();
      this.updateSummary();
      void updateVoiceOptions();
    };

    this.speechProviderSetting = new Setting(itemsEl)
      .setName(COPY.provider)
      .addDropdown(dropdown => {
        const selection = this.speechSelection();
        const usable = this.speechAvailability().filter(item => item.enabled && item.configured && (item.models?.length ?? 0) > 0);

        if (usable.length === 0 && !selection.provider) {
          dropdown.addOption('', VOICE_COPY.noSpeech);
          dropdown.setDisabled(true);
          return;
        }
        usable.forEach(provider => {
          dropdown.addOption(provider.provider, this.host.getProviderDisplayName(provider.provider));
        });
        if (selection.provider && !usable.some(provider => provider.provider === selection.provider)) {
          dropdown.addOption(selection.provider, `${this.host.getProviderDisplayName(selection.provider)} (unavailable)`);
        }
        dropdown.setValue(selection.provider || usable[0]?.provider || '');
        dropdown.onChange(provider => {
          const model = this.speechAvailability().find(item => item.provider === provider)?.models?.[0];
          this.settings.speechProvider = provider || undefined;
          this.settings.speechModel = model?.id;
          this.settings.speechVoice = model?.defaultVoice;
          markUser();
          this.host.notifyChange();
          this.updateWarnings();
          void updateModelOptions();
        });
      });

    new Setting(itemsEl)
      .setName(COPY.model)
      .addDropdown(dropdown => {
        modelDropdown = dropdown.selectEl;
        void updateModelOptions();
        dropdown.onChange(modelId => {
          const selection = this.speechSelection();
          const model = getSpeechModel(selection.provider, modelId);
          this.settings.speechProvider = selection.provider;
          this.settings.speechModel = modelId || undefined;
          if (model) this.settings.speechVoice = this.settings.speechVoice || model.defaultVoice;
          this.names.speechModel = modelDropdown?.selectedOptions?.[0]?.text ?? model?.name ?? modelId;
          markUser();
          this.host.notifyChange();
          this.updateWarnings();
          this.updateSummary();
          void updateVoiceOptions();
        });
      });

    new Setting(itemsEl)
      .setName(VOICE_COPY.voice)
      .addDropdown(dropdown => {
        voiceDropdown = dropdown.selectEl;
        void updateVoiceOptions();
        dropdown.onChange(voice => {
          const selection = this.speechSelection();
          this.settings.speechProvider = selection.provider;
          this.settings.speechModel = selection.model;
          this.settings.speechVoice = voice || undefined;
          this.names.speechVoice = voice ? voiceDropdown?.selectedOptions?.[0]?.text ?? voice : undefined;
          markUser();
          this.host.notifyChange();
          this.updateWarnings();
          this.updateSummary();
        });
      });
  }

  private renderAudioFolder(itemsEl: HTMLElement, option: VoiceAudioFolderOption): void {
    new Setting(itemsEl)
      .setName(VOICE_COPY.savedAudioFolder)
      .setDesc(VOICE_COPY.savedAudioFolderDesc)
      .addText(text => {
        text
          .setPlaceholder(option.placeholder)
          .setValue(option.getValue())
          .onChange(value => option.onChange(value));
      });
  }

  // ---------- Live voice ----------

  private realtimeAvailability(): RealtimeVoiceProviderAvailability[] {
    return buildRealtimeVoiceProviderAvailability(this.host.llmProviderSettings, this.getRealtimeAppStates());
  }

  private realtimeSelection(): { provider?: string; model?: string; voice?: string } {
    const availability = this.realtimeAvailability();
    const provider = this.settings.realtimeVoiceProvider
      || availability.find(item => item.enabled && item.configured && (item.models?.length ?? 0) > 0)?.provider;
    const providerAvailability = availability.find(item => item.provider === provider);
    const model = this.settings.realtimeVoiceModel && providerAvailability?.models?.some(candidate => candidate.id === this.settings.realtimeVoiceModel)
      ? this.settings.realtimeVoiceModel
      : providerAvailability?.models?.[0]?.id;
    return { provider, model, voice: this.settings.realtimeVoiceVoice };
  }

  private renderRealtime(itemsEl: HTMLElement): void {
    const usable = this.realtimeAvailability().filter(item => item.enabled && item.configured && (item.models?.length ?? 0) > 0);
    const initial = this.realtimeSelection();
    this.realtimeAvailable = usable.length > 0 || !!initial.provider;

    if (!this.realtimeAvailable) {
      new Setting(itemsEl)
        .setName(COPY.provider)
        .setDesc(VOICE_COPY.noLiveVoice)
        .setDisabled(true)
        .addDropdown(dropdown => {
          dropdown.addOption('', VOICE_COPY.noLiveVoiceOption);
          dropdown.setDisabled(true);
        });
      new Setting(itemsEl)
        .setName(COPY.model)
        .setDisabled(true)
        .addDropdown(dropdown => {
          dropdown.addOption('', '—');
          dropdown.setDisabled(true);
        });
      new Setting(itemsEl)
        .setName(VOICE_COPY.output)
        .setDisabled(true)
        .addDropdown(dropdown => {
          dropdown.addOption('', 'Provider default');
          dropdown.setDisabled(true);
        });
      return;
    }

    let modelDropdown: HTMLSelectElement | null = null;
    let voiceDropdown: HTMLSelectElement | null = null;
    const markUser = (): void => {
      this.settings.realtimeVoiceSource = 'user';
    };

    const updateVoiceOptions = (): void => {
      if (!voiceDropdown) return;
      const selection = this.realtimeSelection();
      const model = getRealtimeVoiceModel(selection.provider, selection.model);
      const voices = model?.voices ?? [];
      const usesSpeechDefault = model?.execution === 'transcription-pipeline';

      voiceDropdown.empty();
      voiceDropdown.createEl('option', { value: '', text: usesSpeechDefault ? 'Uses speech default' : 'Provider default' });
      voices.forEach(voice => {
        voiceDropdown?.createEl('option', { value: voice.id, text: voice.name });
      });
      if (selection.voice && !voices.some(voice => voice.id === selection.voice)) {
        voiceDropdown.createEl('option', { value: selection.voice, text: `${selection.voice} (unavailable)` });
      }
      voiceDropdown.disabled = usesSpeechDefault || !selection.provider || !selection.model;
      voiceDropdown.value = usesSpeechDefault ? '' : selection.voice || '';
    };

    const updateModelOptions = (): void => {
      if (!modelDropdown) return;
      const selection = this.realtimeSelection();
      const providerAvailability = this.realtimeAvailability().find(item => item.provider === selection.provider);
      const providerUsable = providerAvailability?.enabled === true && providerAvailability.configured === true;
      const models = providerAvailability?.models ?? [];

      modelDropdown.empty();
      if (!selection.provider || models.length === 0) {
        modelDropdown.createEl('option', { value: '', text: 'Select a live voice provider first' });
        modelDropdown.disabled = true;
        updateVoiceOptions();
        return;
      }

      sortModelsNewestFirst(models, model => ({ provider: selection.provider || '', id: model.id })).forEach(model => {
        modelDropdown?.createEl('option', { value: model.id, text: model.name });
      });
      if (selection.model && !models.some(model => model.id === selection.model)) {
        modelDropdown.createEl('option', { value: selection.model, text: `${selection.model} (unavailable)` });
      }

      const nextModel = selection.model && models.some(model => model.id === selection.model)
        ? selection.model
        : models[0]?.id || '';
      modelDropdown.disabled = !providerUsable;
      modelDropdown.value = nextModel;
      this.settings.realtimeVoiceProvider = selection.provider;
      this.settings.realtimeVoiceModel = nextModel || undefined;
      updateVoiceOptions();
    };

    this.realtimeProviderSetting = new Setting(itemsEl)
      .setName(COPY.provider)
      .addDropdown(dropdown => {
        usable.forEach(provider => {
          dropdown.addOption(provider.provider, this.host.getProviderDisplayName(provider.provider));
        });
        if (initial.provider && !usable.some(provider => provider.provider === initial.provider)) {
          dropdown.addOption(initial.provider, `${this.host.getProviderDisplayName(initial.provider)} (unavailable)`);
        }
        dropdown.setValue(initial.provider || usable[0]?.provider || '');
        dropdown.onChange(provider => {
          const model = this.realtimeAvailability().find(item => item.provider === provider)?.models?.[0];
          this.settings.realtimeVoiceProvider = provider || undefined;
          this.settings.realtimeVoiceModel = model?.id;
          this.settings.realtimeVoiceVoice = model?.defaultVoice;
          markUser();
          this.host.notifyChange();
          updateModelOptions();
          this.updateWarnings();
        });
      });

    new Setting(itemsEl)
      .setName(COPY.model)
      .addDropdown(dropdown => {
        modelDropdown = dropdown.selectEl;
        updateModelOptions();
        dropdown.onChange(modelId => {
          const selection = this.realtimeSelection();
          const model = getRealtimeVoiceModel(selection.provider, modelId);
          this.settings.realtimeVoiceProvider = selection.provider;
          this.settings.realtimeVoiceModel = modelId || undefined;
          if (model) this.settings.realtimeVoiceVoice = this.settings.realtimeVoiceVoice || model.defaultVoice;
          markUser();
          this.host.notifyChange();
          updateVoiceOptions();
          this.updateWarnings();
        });
      });

    new Setting(itemsEl)
      .setName(VOICE_COPY.output)
      .addDropdown(dropdown => {
        voiceDropdown = dropdown.selectEl;
        updateVoiceOptions();
        dropdown.onChange(voice => {
          const selection = this.realtimeSelection();
          this.settings.realtimeVoiceProvider = selection.provider;
          this.settings.realtimeVoiceModel = selection.model;
          this.settings.realtimeVoiceVoice = voice || undefined;
          markUser();
          this.host.notifyChange();
          this.updateWarnings();
        });
      });
  }

  // ---------- Warnings ----------

  /** A saved pick that no longer resolves is explained on its Provider row. */
  private updateWarnings(): void {
    const { speech, realtime } = this.getWarnings();
    this.speechProviderSetting?.setDesc(speech ?? '');
    if (this.realtimeAvailable) this.realtimeProviderSetting?.setDesc(realtime ?? '');
  }

  getWarnings(): { speech?: string; realtime?: string } {
    const llm = this.host.llmProviderSettings;
    const speechSet = this.settings.speechProvider || this.settings.speechModel || this.settings.speechVoice;
    const realtimeSet = this.settings.realtimeVoiceProvider || this.settings.realtimeVoiceModel || this.settings.realtimeVoiceVoice;

    const speech = speechSet && this.settings.speechSource !== 'auto'
      ? resolveDefaultSpeechSelection(
        {
          ...llm,
          defaultSpeechModel: {
            provider: this.settings.speechProvider,
            model: this.settings.speechModel,
            voice: this.settings.speechVoice,
            source: 'user'
          }
        },
        this.speechAvailability()
      )
      : undefined;
    const realtime = realtimeSet && this.settings.realtimeVoiceSource !== 'auto'
      ? resolveDefaultRealtimeVoiceSelection(
        {
          ...llm,
          defaultRealtimeVoiceModel: {
            provider: this.settings.realtimeVoiceProvider,
            model: this.settings.realtimeVoiceModel,
            voice: this.settings.realtimeVoiceVoice,
            source: 'user'
          }
        },
        this.realtimeAvailability()
      )
      : undefined;

    return {
      speech: speech?.status === 'invalid' ? speech.reason : undefined,
      realtime: realtime?.status === 'invalid' ? realtime.reason : undefined
    };
  }
}
