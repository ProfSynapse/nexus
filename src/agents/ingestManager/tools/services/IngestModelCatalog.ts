/**
 * Location: src/agents/ingestManager/tools/services/IngestModelCatalog.ts
 * Purpose: Shared declarations for ingestion-only OCR models that are not part
 * of the normal chat model registry. Transcription models now live in the
 * shared VoiceTypes catalog so ingest, defaults, and the audio editor all use
 * one source of truth.
 */

export type IngestionModelKind = 'ocr' | 'transcription';
export type IngestionModelExecution = 'speech-api-segmented' | 'speech-api-plain' | 'multimodal-audio';

export interface IngestionModelDeclaration {
  provider: string;
  id: string;
  name: string;
  kind: IngestionModelKind;
  execution?: IngestionModelExecution;
}

const INGESTION_MODELS: IngestionModelDeclaration[] = [
  {
    provider: 'openrouter',
    id: 'mistral-ocr',
    name: 'Mistral OCR (PDF OCR)',
    kind: 'ocr'
  }
];

export function getIngestionModelsForProvider(
  providerId: string,
  kind?: IngestionModelKind
): IngestionModelDeclaration[] {
  return INGESTION_MODELS.filter(model =>
    model.provider === providerId && (!kind || model.kind === kind)
  );
}

export function getIngestionModel(
  providerId: string,
  modelId: string,
  kind?: IngestionModelKind
): IngestionModelDeclaration | undefined {
  return INGESTION_MODELS.find(model =>
    model.provider === providerId &&
    model.id === modelId &&
    (!kind || model.kind === kind)
  );
}

export function getIngestionProvidersForKind(kind: IngestionModelKind): string[] {
  return Array.from(
    new Set(
      INGESTION_MODELS
        .filter(model => model.kind === kind)
        .map(model => model.provider)
    )
  );
}
