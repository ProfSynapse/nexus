import { Setting } from 'obsidian';
import {
  IngestProviderOption,
  normalizeIngestSelection
} from '../../agents/ingestManager/tools/services/IngestCapabilityService';

export interface IngestModelDropdownConfig {
  labelPrefix: string;
  description?: string;
  providers: IngestProviderOption[];
  getSelection: () => { provider: string; model: string } | undefined;
  onChange: (provider: string | undefined, model: string | undefined) => Promise<void> | void;
  providerSettingName?: string;
  modelSettingName?: string;
}

export function renderIngestModelDropdowns(
  container: HTMLElement,
  config: IngestModelDropdownConfig
): void {
  let modelDropdown: HTMLSelectElement | null = null;

  const updateModelOptions = (): void => {
    if (!modelDropdown) {
      return;
    }

    const selection = config.getSelection();
    const providerId = selection?.provider;
    const provider = config.providers.find(option => option.id === providerId);
    const normalizedSelection = normalizeIngestSelection(
      config.providers,
      selection?.provider,
      selection?.model
    );

    modelDropdown.empty();

    if (!providerId || !provider || provider.models.length === 0) {
      modelDropdown.createEl('option', {
        value: '',
        text: config.providers.length === 0
          ? `No ${config.labelPrefix.toLowerCase()} models available`
          : 'Select a provider first'
      });
      modelDropdown.disabled = true;
      return;
    }

    provider.models.forEach(model => {
      modelDropdown?.createEl('option', {
        value: model.id,
        text: model.name
      });
    });

    modelDropdown.disabled = false;
    modelDropdown.value = provider.models.some(model => model.id === normalizedSelection.model)
      ? normalizedSelection.model || provider.models[0].id
      : provider.models[0].id;
  };

  new Setting(container)
    .setName(config.providerSettingName ?? `${config.labelPrefix} provider`)
    .setDesc(config.description ?? '')
    .addDropdown(dropdown => {
      if (config.providers.length === 0) {
        dropdown.addOption('', `No ${config.labelPrefix.toLowerCase()} providers available`);
        dropdown.setDisabled(true);
        return;
      }

      config.providers.forEach(provider => {
        dropdown.addOption(provider.id, provider.name);
      });

      const normalizedSelection = normalizeIngestSelection(
        config.providers,
        config.getSelection()?.provider,
        config.getSelection()?.model
      );

      dropdown.setValue(normalizedSelection.provider || config.providers[0].id);
      dropdown.onChange((value) => {
        const nextSelection = normalizeIngestSelection(config.providers, value, undefined);
        void Promise.resolve(config.onChange(nextSelection.provider, nextSelection.model))
          .then(updateModelOptions);
      });
    });

  new Setting(container)
    .setName(config.modelSettingName ?? `${config.labelPrefix} model`)
    .addDropdown(dropdown => {
      modelDropdown = dropdown.selectEl;
      updateModelOptions();

      dropdown.onChange((value) => {
        const selection = config.getSelection();
        void Promise.resolve(config.onChange(selection?.provider, value || undefined))
          .then(updateModelOptions);
      });
    });
}
