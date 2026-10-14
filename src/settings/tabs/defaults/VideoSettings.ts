/**
 * The Video fold on Defaults: provider, model, aspect ratio and resolution for
 * the generateVideo tool. Edits the shared renderer's settings object; the
 * Defaults tab persists the result through its save queue.
 */

import { Setting } from 'obsidian';
import {
  buildVideoProviderAvailability,
  getVideoModel,
  type VideoAspectRatio,
  type VideoModelDeclaration,
  type VideoResolution,
} from '../../../services/llm/types/VideoTypes';
import { sortModelsNewestFirst } from '../../../utils/modelOrdering';
import { ProviderUtils } from '../../../ui/chat/utils/ProviderUtils';
import { COPY, FOLD_ICONS, FOLD_IDS, FOLD_TITLES, VIDEO_COPY } from '../../../components/shared/chatSettings/copy';
import { videoSummary } from '../../../components/shared/chatSettings/sectionSummaries';
import type { FoldDefinition, FoldHost } from '../../../components/shared/chatSettings/types';

interface VideoSelection {
  provider?: 'google' | 'openrouter';
  model?: string;
  modelDeclaration?: VideoModelDeclaration;
  aspectRatio?: VideoAspectRatio;
  resolution?: VideoResolution;
}

export class VideoSettings implements FoldDefinition {
  readonly id = FOLD_IDS.video;
  readonly title = FOLD_TITLES.video;
  readonly icon = FOLD_ICONS.video;
  /** Sits after Images, before Voice. */
  readonly after = FOLD_IDS.images;

  render(itemsEl: HTMLElement, host: FoldHost): void {
    const availability = () => buildVideoProviderAvailability(host.llmProviderSettings);
    const selection = (): VideoSelection => {
      const settings = host.settings;
      const all = availability();
      const provider = settings.videoProvider
        || all.find(item => item.enabled && item.configured && item.models.length > 0)?.provider;
      const providerAvailability = all.find(item => item.provider === provider);
      const model = settings.videoModel && providerAvailability?.models.some(candidate => candidate.id === settings.videoModel)
        ? settings.videoModel
        : providerAvailability?.models[0]?.id;
      const modelDeclaration = getVideoModel(provider, model) || providerAvailability?.models.find(candidate => candidate.id === model);
      return {
        provider,
        model,
        modelDeclaration,
        aspectRatio: settings.videoAspectRatio || modelDeclaration?.defaultAspectRatio,
        resolution: settings.videoResolution || modelDeclaration?.defaultResolution,
      };
    };

    const isUsable = (item: ReturnType<typeof availability>[number]): boolean =>
      item.enabled && item.configured && item.models.length > 0;

    const updateSummary = (): void => {
      const current = selection();
      const all = availability();
      // A saved provider whose key was removed still resolves a model from
      // the catalog; the summary must not present that as the active choice
      // while the Provider dropdown marks it "(unavailable)".
      const selected = all.find(item => item.provider === current.provider);
      host.setSummary(videoSummary({
        modelName: current.modelDeclaration?.name ?? current.model,
        aspectRatio: current.aspectRatio,
        resolution: current.resolution,
        anyProviderUsable: all.some(isUsable),
        providerUsable: selected ? isUsable(selected) : false
      }));
    };

    const choose = (model: VideoModelDeclaration, aspectRatio?: VideoAspectRatio, resolution?: VideoResolution): void => {
      host.settings.videoProvider = model.provider;
      host.settings.videoModel = model.id;
      host.settings.videoAspectRatio = aspectRatio || model.defaultAspectRatio;
      host.settings.videoResolution = resolution || model.defaultResolution;
      host.notifyChange();
      updateSummary();
    };

    const current = selection();
    const usable = availability().filter(isUsable);

    new Setting(itemsEl)
      .setName(COPY.provider)
      .addDropdown(dropdown => {
        if (usable.length === 0 && !current.provider) {
          dropdown.addOption('', VIDEO_COPY.noProviders);
          dropdown.setDisabled(true);
          return;
        }
        for (const provider of usable) {
          dropdown.addOption(provider.provider, ProviderUtils.getProviderDisplayName(provider.provider));
        }
        if (current.provider && !usable.some(provider => provider.provider === current.provider)) {
          dropdown.addOption(current.provider, `${ProviderUtils.getProviderDisplayName(current.provider)} (unavailable)`);
        }
        dropdown.setValue(current.provider || usable[0]?.provider || '');
        dropdown.onChange(provider => {
          const model = availability().find(item => item.provider === provider)?.models[0];
          if (!model) return;
          choose(model);
          host.redraw();
        });
      });

    const providerAvailability = availability().find(item => item.provider === current.provider);
    const models = providerAvailability?.models ?? [];
    new Setting(itemsEl)
      .setName(COPY.model)
      .addDropdown(dropdown => {
        if (!current.provider || models.length === 0) {
          dropdown.addOption('', VIDEO_COPY.selectProvider);
          dropdown.setDisabled(true);
          return;
        }
        for (const model of sortModelsNewestFirst(models, item => ({ provider: current.provider || '', id: item.id }))) {
          dropdown.addOption(model.id, model.name);
        }
        dropdown.setValue(current.model || models[0]?.id || '');
        dropdown.setDisabled(providerAvailability?.enabled !== true || providerAvailability.configured !== true);
        dropdown.onChange(modelId => {
          const before = selection();
          const model = getVideoModel(before.provider, modelId);
          if (!model) return;
          // Keep the chosen ratio and resolution when the new model supports them.
          choose(
            model,
            before.aspectRatio && model.aspectRatios.includes(before.aspectRatio) ? before.aspectRatio : undefined,
            before.resolution && model.resolutions.includes(before.resolution) ? before.resolution : undefined
          );
          host.redraw();
        });
      });

    const model = current.modelDeclaration;
    new Setting(itemsEl)
      .setName(VIDEO_COPY.aspectRatio)
      .addDropdown(dropdown => {
        if (!model) {
          dropdown.addOption('', VIDEO_COPY.selectModel);
          dropdown.setDisabled(true);
          return;
        }
        for (const value of model.aspectRatios) dropdown.addOption(value, value);
        dropdown.setValue(current.aspectRatio || model.defaultAspectRatio);
        dropdown.onChange(value => {
          const latest = selection();
          if (latest.modelDeclaration) choose(latest.modelDeclaration, value as VideoAspectRatio, latest.resolution);
        });
      });

    new Setting(itemsEl)
      .setName(VIDEO_COPY.resolution)
      .addDropdown(dropdown => {
        if (!model) {
          dropdown.addOption('', VIDEO_COPY.selectModel);
          dropdown.setDisabled(true);
          return;
        }
        for (const value of model.resolutions) dropdown.addOption(value, value);
        dropdown.setValue(current.resolution || model.defaultResolution);
        dropdown.onChange(value => {
          const latest = selection();
          if (latest.modelDeclaration) choose(latest.modelDeclaration, latest.aspectRatio, value as VideoResolution);
        });
      });

    updateSummary();
  }
}
