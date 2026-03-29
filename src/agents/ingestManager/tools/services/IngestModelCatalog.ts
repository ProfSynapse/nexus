/**
 * Location: src/agents/ingestManager/tools/services/IngestModelCatalog.ts
 * Purpose: Shared declarations for ingestion-only models that are not part of
 * the normal chat model registry.
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
  },
  {
    provider: 'openai',
    id: 'gpt-4o-transcribe',
    name: 'GPT-4o Transcribe',
    kind: 'transcription',
    execution: 'speech-api-plain'
  },
  {
    provider: 'openai',
    id: 'gpt-4o-mini-transcribe',
    name: 'GPT-4o Mini Transcribe',
    kind: 'transcription',
    execution: 'speech-api-plain'
  },
  {
    provider: 'openai',
    id: 'whisper-1',
    name: 'Whisper 1 (Transcription)',
    kind: 'transcription',
    execution: 'speech-api-segmented'
  },
  {
    provider: 'groq',
    id: 'whisper-large-v3-turbo',
    name: 'Whisper Large v3 Turbo (Transcription)',
    kind: 'transcription',
    execution: 'speech-api-segmented'
  },
  {
    provider: 'groq',
    id: 'whisper-large-v3',
    name: 'Whisper Large v3 (Transcription)',
    kind: 'transcription',
    execution: 'speech-api-segmented'
  },
  {
    provider: 'google',
    id: 'gemini-3-flash-preview',
    name: 'Gemini 3.0 Flash Preview (Audio)',
    kind: 'transcription',
    execution: 'multimodal-audio'
  },
  {
    provider: 'google',
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash (Audio)',
    kind: 'transcription',
    execution: 'multimodal-audio'
  },
  {
    provider: 'openrouter',
    id: 'google/gemini-3-flash-preview',
    name: 'Gemini 3.0 Flash Preview (Audio)',
    kind: 'transcription',
    execution: 'multimodal-audio'
  },
  {
    provider: 'openrouter',
    id: 'google/gemini-2.5-flash',
    name: 'Gemini 2.5 Flash (Audio)',
    kind: 'transcription',
    execution: 'multimodal-audio'
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
