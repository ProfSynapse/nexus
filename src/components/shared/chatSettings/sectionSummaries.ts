/**
 * One-line summaries shown under each closed settings fold. Pure functions of
 * the settings plus whatever names have loaded, so they are cheap to recompute
 * after every change.
 */

import type { ThinkingState } from './thinkingOptions';
import { THINKING_LABELS } from './thinkingOptions';
import { COPY } from './copy';

const SEPARATOR = ' · ';

function join(parts: Array<string | null | undefined | false>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(SEPARATOR);
}

/** "32K", "200K", "1M", "1.05M"; below 1,000 the raw count. */
export function formatContextWindow(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens >= 1_000_000) {
    const millions = Math.round((tokens / 1_000_000) * 100) / 100;
    return `${millions}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(Math.round(tokens));
}

export function formatTemperature(value: number): string {
  return value.toFixed(1);
}

export interface TuningSummaryInput {
  temperature: number;
  /** False when the model sets its own temperature. */
  supportsTemperature?: boolean;
  /** The context budget in tokens, when the model's window is known. */
  contextWindow?: number;
}

export interface ChatOptionsSummaryInput extends TuningSummaryInput {
  /** Chat settings only; omit on Defaults. */
  webSearch?: boolean;
}

/** "Creativity 0.5" or "Fixed temperature", then "1M context" when the window is known. */
export function tuningSummary(input: TuningSummaryInput): string[] {
  const parts = [
    input.supportsTemperature === false ? COPY.fixedTemperature : `Creativity ${formatTemperature(input.temperature)}`
  ];
  if (input.contextWindow) parts.push(`${formatContextWindow(input.contextWindow)} context`);
  return parts;
}

export function chatOptionsSummary(input: ChatOptionsSummaryInput): string {
  return join([
    ...tuningSummary(input),
    input.webSearch === undefined ? null : `Web search ${input.webSearch ? 'on' : 'off'}`
  ]);
}

export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function contextSummary(input: { workspaceName?: string | null; promptName?: string | null; noteCount: number }): string {
  return join([
    input.workspaceName || 'No workspace',
    input.promptName || 'No prompt',
    countLabel(input.noteCount, 'note')
  ]);
}

export function thinkingSummary(thinking: ThinkingState | undefined): string {
  if (!thinking?.enabled) return 'Thinking off';
  return `${THINKING_LABELS[thinking.effort]} thinking`;
}

export function subagentsSummary(input: {
  modelName?: string | null;
  /** Null when the model cannot reason, so no thinking state applies. */
  thinking?: ThinkingState | null;
  tuning?: string[];
}): string {
  return join([
    input.modelName || 'Not set',
    input.thinking === null || input.thinking === undefined ? null : thinkingSummary(input.thinking),
    ...(input.tuning ?? [])
  ]);
}

/**
 * Whether the media provider behind a summary can run at all. Both default to
 * usable, so a caller that does not know yet does not blank the summary.
 */
export interface MediaProviderUsability {
  /** False when the selected provider has no API key or is turned off. */
  providerUsable?: boolean;
  /** False when no provider of this kind has a key and is turned on. */
  anyProviderUsable?: boolean;
}

/**
 * Naming a model whose provider cannot run claimed a setting that does not
 * work: the Images summary said "Nano Banana 2" while its Model dropdown said
 * "No models available". The model id stays saved; the summary just stops
 * presenting it as the active choice.
 */
function unusableMediaSummary(input: MediaProviderUsability, noneLabel: string): string | null {
  if (input.anyProviderUsable === false) return noneLabel;
  if (input.providerUsable === false) return COPY.notSet;
  return null;
}

export function imagesSummary(input: { modelName?: string | null } & MediaProviderUsability): string {
  return unusableMediaSummary(input, COPY.noImageProvider) ?? (input.modelName || COPY.notSet);
}

export function videoSummary(
  input: { modelName?: string | null; aspectRatio?: string | null; resolution?: string | null } & MediaProviderUsability
): string {
  return unusableMediaSummary(input, COPY.noVideoProvider)
    ?? join([input.modelName || COPY.notSet, input.aspectRatio, input.resolution]);
}

export function voiceSummary(input: { transcriptionModel?: string | null; readAloudModel?: string | null; voice?: string | null }): string {
  const readAloud = input.readAloudModel
    ? `${input.readAloudModel}${input.voice ? ` (${input.voice})` : ''}`
    : null;
  return join([input.transcriptionModel, readAloud]) || 'Not set';
}

export function fileConversionSummary(input: { enabled: boolean; vision: boolean; autoConvert: boolean }): string {
  if (!input.enabled) return 'File import off';
  return join(['File import on', input.vision ? 'Vision' : 'Text extraction', input.autoConvert ? 'auto-convert' : null]);
}

export function semanticSearchSummary(input: {
  enabled: boolean;
  noteCount?: number;
  indexingPercent?: number;
  /** With indexingPercent: the pass is comparing notes, not embedding them. */
  checking?: boolean;
  /** While off: false once the index was deleted. Unknown counts as kept. */
  indexKept?: boolean;
  /** While on: the embedding model failed to load, so nothing is indexed. */
  loadFailed?: boolean;
}): string {
  if (!input.enabled) return input.indexKept === false ? 'Off · no index' : 'Off · index kept';
  if (input.loadFailed) return "On · couldn't load";
  if (typeof input.indexingPercent === 'number') {
    return `${input.checking ? 'Checking' : 'Indexing'} · ${Math.round(input.indexingPercent)}%`;
  }
  if (typeof input.noteCount === 'number') return `On · ${input.noteCount.toLocaleString()} notes`;
  return 'On';
}
