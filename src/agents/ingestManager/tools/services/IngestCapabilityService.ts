/**
 * Location: src/agents/ingestManager/tools/services/IngestCapabilityService.ts
 * Purpose: Shared capability discovery for the ingest pipeline UI and tools.
 *
 * OCR and transcription capabilities are derived from the explicit ingestion
 * model catalog so the ingest UI only exposes models we actually support for
 * those tasks.
 */

import type { LLMProviderManager } from '../../../../services/llm/providers/ProviderManager';
import { ProviderUtils } from '../../../../ui/chat/utils/ProviderUtils';
import {
  getIngestionModelsForProvider,
  IngestionModelKind
} from './IngestModelCatalog';
import { getTranscriptionModelsForProvider } from '../../../../services/llm/types/VoiceTypes';

export interface IngestModelOption {
  id: string;
  name: string;
}

export interface IngestProviderOption {
  id: string;
  name: string;
  models: IngestModelOption[];
}

export interface IngestCapabilityOptions {
  ocrProviders: IngestProviderOption[];
  transcriptionProviders: IngestProviderOption[];
}

export async function getIngestCapabilityOptions(
  providerManager: LLMProviderManager | null
): Promise<IngestCapabilityOptions> {
  if (!providerManager) {
    return {
      ocrProviders: [],
      transcriptionProviders: []
    };
  }

  const [ocrProviders, transcriptionProviders] = await Promise.all([
    Promise.resolve(getProviderOptions(providerManager, 'ocr')),
    Promise.resolve(getProviderOptions(providerManager, 'transcription'))
  ]);

  return {
    ocrProviders,
    transcriptionProviders
  };
}

export function normalizeIngestSelection(
  providers: IngestProviderOption[],
  providerId?: string,
  modelId?: string
): { provider?: string; model?: string } {
  if (providers.length === 0) {
    return {};
  }

  const selectedProvider = providers.find(provider => provider.id === providerId) ?? providers[0];
  if (!selectedProvider) {
    return {};
  }

  const selectedModel = selectedProvider.models.find(model => model.id === modelId) ?? selectedProvider.models[0];

  return {
    provider: selectedProvider.id,
    model: selectedModel?.id
  };
}

function getProviderOptions(
  providerManager: LLMProviderManager,
  kind: IngestionModelKind
): IngestProviderOption[] {
  const settings = providerManager.getSettings();
  const groupedProviders = new Map<string, IngestProviderOption>();

  for (const providerId of Object.keys(settings.providers ?? {})) {
    const config = settings.providers?.[providerId];
    if (!config?.enabled || !config.apiKey) {
      continue;
    }

    const models = kind === 'transcription'
      ? getTranscriptionModelsForProvider(providerId)
      : getIngestionModelsForProvider(providerId, kind);

    for (const model of models) {
      if (config.models?.[model.id]?.enabled === false) {
        continue;
      }

      addModelOption(groupedProviders, providerId, {
        id: model.id,
        name: model.name
      });
    }
  }

  return Array.from(groupedProviders.values())
    .map(provider => ({
      ...provider,
      models: provider.models.sort((left, right) => left.name.localeCompare(right.name))
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function addModelOption(
  groupedProviders: Map<string, IngestProviderOption>,
  providerId: string,
  model: IngestModelOption
): void {
  const provider = groupedProviders.get(providerId) ?? {
    id: providerId,
    name: ProviderUtils.getProviderDisplayName(providerId),
    models: []
  };

  if (!provider.models.some(existingModel => existingModel.id === model.id)) {
    provider.models.push(model);
  }

  groupedProviders.set(providerId, provider);
}
