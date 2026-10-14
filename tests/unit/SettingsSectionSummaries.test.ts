/**
 * Collapsed fold summaries. Each string is what a closed fold shows, so a
 * wrong separator, missing part or stale wording is visible to every user.
 */
import {
  chatOptionsSummary,
  contextSummary,
  fileConversionSummary,
  formatContextWindow,
  imagesSummary,
  semanticSearchSummary,
  subagentsSummary,
  tuningSummary,
  videoSummary,
  voiceSummary
} from '../../src/components/shared/chatSettings/sectionSummaries';

it('formats context windows compactly', () => {
  expect(formatContextWindow(32_000)).toBe('32K');
  expect(formatContextWindow(200_000)).toBe('200K');
  expect(formatContextWindow(1_000_000)).toBe('1M');
  expect(formatContextWindow(1_050_000)).toBe('1.05M');
  expect(formatContextWindow(4096)).toBe('4K');
  expect(formatContextWindow(512)).toBe('512');
});

it('summarises chat options, with web search only where it is shown', () => {
  expect(chatOptionsSummary({ temperature: 0.5, contextWindow: 1_000_000 })).toBe('Creativity 0.5 · 1M context');
  expect(chatOptionsSummary({ temperature: 0.5, supportsTemperature: false, contextWindow: 1_000_000 }))
    .toBe('Fixed temperature · 1M context');
  expect(chatOptionsSummary({ temperature: 0.7, contextWindow: 200_000, webSearch: false }))
    .toBe('Creativity 0.7 · 200K context · Web search off');
  expect(chatOptionsSummary({ temperature: 0.7, webSearch: true })).toBe('Creativity 0.7 · Web search on');
});

it('summarises context with fallbacks for an empty selection', () => {
  expect(contextSummary({ workspaceName: null, promptName: null, noteCount: 0 })).toBe('No workspace · No prompt · 0 notes');
  expect(contextSummary({ workspaceName: 'On Networks', promptName: 'meditations-on-alignment', noteCount: 3 }))
    .toBe('On Networks · meditations-on-alignment · 3 notes');
  expect(contextSummary({ workspaceName: 'On Networks', promptName: null, noteCount: 1 })).toBe('On Networks · No prompt · 1 note');
});

it('summarises subagents with thinking only for reasoning models', () => {
  expect(subagentsSummary({ modelName: 'Claude Haiku 5.5', thinking: { enabled: false, effort: 'medium' } }))
    .toBe('Claude Haiku 5.5 · Thinking off');
  expect(subagentsSummary({ modelName: 'Claude Haiku 5.5', thinking: { enabled: true, effort: 'xhigh' } }))
    .toBe('Claude Haiku 5.5 · Extra high thinking');
  expect(subagentsSummary({ modelName: 'Mistral Large Latest', thinking: null })).toBe('Mistral Large Latest');
  expect(subagentsSummary({ modelName: 'Claude Haiku 5.5', thinking: null, tuning: ['Fixed temperature', '1M context'] }))
    .toBe('Claude Haiku 5.5 · Fixed temperature · 1M context');
});

it('builds the subagent tuning parts the way Chat options does', () => {
  expect(tuningSummary({ temperature: 0.3, contextWindow: 200_000 })).toEqual(['Creativity 0.3', '200K context']);
  expect(tuningSummary({ temperature: 0.3, supportsTemperature: false, contextWindow: 1_000_000 }))
    .toEqual(['Fixed temperature', '1M context']);
  expect(tuningSummary({ temperature: 0.5 })).toEqual(['Creativity 0.5']);
  expect(subagentsSummary({
    modelName: 'Claude Haiku 5.5',
    thinking: { enabled: false, effort: 'medium' },
    tuning: tuningSummary({ temperature: 0.5, supportsTemperature: false, contextWindow: 1_000_000 })
  })).toBe('Claude Haiku 5.5 · Thinking off · Fixed temperature · 1M context');
});

it('summarises images, video and voice', () => {
  expect(imagesSummary({ modelName: 'Gemini 3.1 Flash Image' })).toBe('Gemini 3.1 Flash Image');
  expect(imagesSummary({ modelName: 'Nano Banana 2', providerUsable: false, anyProviderUsable: false })).toBe('No image provider');
  expect(imagesSummary({ modelName: 'Nano Banana 2', providerUsable: false, anyProviderUsable: true })).toBe('Not set');
  expect(imagesSummary({})).toBe('Not set');
  expect(videoSummary({ modelName: 'Veo 3.1', aspectRatio: '16:9', resolution: '720p' })).toBe('Veo 3.1 · 16:9 · 720p');
  expect(videoSummary({ modelName: 'Veo 3.1', aspectRatio: '16:9', resolution: '720p', anyProviderUsable: false })).toBe('No video provider');
  expect(videoSummary({ modelName: 'Veo 3.1', aspectRatio: '16:9', resolution: '720p', providerUsable: false })).toBe('Not set');
  expect(voiceSummary({ transcriptionModel: 'Deepgram Nova-3', readAloudModel: 'HeyGen Voice', voice: 'Alloy' }))
    .toBe('Deepgram Nova-3 · HeyGen Voice (Alloy)');
  expect(voiceSummary({ transcriptionModel: 'Deepgram Nova-3', readAloudModel: null })).toBe('Deepgram Nova-3');
  expect(voiceSummary({})).toBe('Not set');
});

it('summarises file conversion by the File import switch', () => {
  expect(fileConversionSummary({ enabled: false, vision: true, autoConvert: true })).toBe('File import off');
  expect(fileConversionSummary({ enabled: true, vision: false, autoConvert: false })).toBe('File import on · Text extraction');
  expect(fileConversionSummary({ enabled: true, vision: true, autoConvert: true })).toBe('File import on · Vision · auto-convert');
});

it('summarises semantic search', () => {
  expect(semanticSearchSummary({ enabled: false })).toBe('Off · index kept');
  expect(semanticSearchSummary({ enabled: false, indexKept: false })).toBe('Off · no index');
  expect(semanticSearchSummary({ enabled: true })).toBe('On');
  expect(semanticSearchSummary({ enabled: true, noteCount: 4512 })).toBe('On · 4,512 notes');
  expect(semanticSearchSummary({ enabled: true, indexingPercent: 42.4 })).toBe('Indexing · 42%');
  expect(semanticSearchSummary({ enabled: true, loadFailed: true, noteCount: 0 })).toBe("On · couldn't load");
  expect(semanticSearchSummary({ enabled: false, loadFailed: true })).toBe('Off · index kept');
});
